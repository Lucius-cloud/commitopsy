import type {
  HealthCheckSchedulingRepository
} from "../db/health-check-repository.js";

export type HealthCheckSchedulerFailurePhase =
  | "poll"
  | "execution";

export interface HealthCheckSchedulerFailure {
  phase: HealthCheckSchedulerFailurePhase;
  errorName: string;
  endpointId?: number;
}

export interface HealthCheckSchedulerOptions {
  repository: Pick<
    HealthCheckSchedulingRepository,
    "findDueEndpoints"
  >;

  executeEndpoint: (endpointId: number) => Promise<unknown>;

  pollingIntervalMs: number;
  maxConcurrentChecks: number;
  batchLimit: number;
  maxQueuedChecks?: number;

  onError?: (failure: HealthCheckSchedulerFailure) => void;
}

function getErrorName(error: unknown): string {
  if (error instanceof Error && error.name.length > 0) {
    return error.name;
  }

  return "UnknownError";
}

/**
 * Single-process health-check scheduler.
 *
 * Guarantees:
 * - Bounded concurrent executions.
 * - No duplicate in-flight execution for an endpoint in this process.
 * - Overlapping polling requests are coalesced.
 * - Endpoint execution failures do not stop other endpoints.
 * - Polling failures do not permanently stop future polling.
 * - Shutdown stops new work and drains active checks.
 *
 * This implementation does not provide multi-instance coordination.
 */
export class HealthCheckScheduler {
  private readonly repository: HealthCheckSchedulerOptions["repository"];
  private readonly executeEndpoint: HealthCheckSchedulerOptions["executeEndpoint"];
  private readonly pollingIntervalMs: number;
  private readonly maxConcurrentChecks: number;
  private readonly batchLimit: number;
  private readonly maxQueuedChecks: number;
  private readonly onError: (
    failure: HealthCheckSchedulerFailure
  ) => void;

  private timer: ReturnType<typeof setInterval> | undefined;
  private pollingPromise: Promise<void> | undefined;

  private started = false;
  private stopping = false;

  private readonly pendingEndpointIds: number[] = [];
  private readonly queuedEndpointIds = new Set<number>();
  private readonly inFlightEndpointIds = new Set<number>();
  private readonly activeTasks = new Set<Promise<void>>();

  constructor(options: HealthCheckSchedulerOptions) {
    if (
      !Number.isSafeInteger(options.pollingIntervalMs) ||
      options.pollingIntervalMs < 100 ||
      options.pollingIntervalMs > 60_000
    ) {
      throw new RangeError(
        "pollingIntervalMs must be between 100 and 60000"
      );
    }

    if (
      !Number.isSafeInteger(options.maxConcurrentChecks) ||
      options.maxConcurrentChecks < 1 ||
      options.maxConcurrentChecks > 50
    ) {
      throw new RangeError(
        "maxConcurrentChecks must be between 1 and 50"
      );
    }

    if (
      !Number.isSafeInteger(options.batchLimit) ||
      options.batchLimit < 1 ||
      options.batchLimit > 500
    ) {
      throw new RangeError(
        "batchLimit must be between 1 and 500"
      );
    }

    const maxQueuedChecks =
      options.maxQueuedChecks ?? options.batchLimit;

    if (
      !Number.isSafeInteger(maxQueuedChecks) ||
      maxQueuedChecks < 1 ||
      maxQueuedChecks > 500
    ) {
      throw new RangeError(
        "maxQueuedChecks must be between 1 and 500"
      );
    }

    this.repository = options.repository;
    this.executeEndpoint = options.executeEndpoint;
    this.pollingIntervalMs = options.pollingIntervalMs;
    this.maxConcurrentChecks = options.maxConcurrentChecks;
    this.batchLimit = options.batchLimit;
    this.maxQueuedChecks = maxQueuedChecks;

    this.onError =
      options.onError ??
      ((failure) => {
        console.error(
          JSON.stringify({
            level: "error",
            message: "Health-check scheduler operation failed",
            ...failure
          })
        );
      });
  }

  /**
   * Starts the scheduler and immediately performs its first poll.
   * Calling start more than once does not create additional timers.
   */
  start(): void {
    if (this.stopping) {
      throw new Error(
        "A stopped health-check scheduler cannot be restarted"
      );
    }

    if (this.started) {
      return;
    }

    this.started = true;

    this.timer = setInterval(() => {
      void this.pollNow();
    }, this.pollingIntervalMs);

    void this.pollNow();
  }

  /**
   * Performs a due-endpoint discovery cycle.
   *
   * Useful for controlled operational triggering and deterministic tests.
   * It does not wait for the actual HTTP checks to finish.
   */
  pollNow(): Promise<void> {
    if (!this.started || this.stopping) {
      return Promise.resolve();
    }

    // Coalesce overlapping polling attempts.
    if (this.pollingPromise) {
      return this.pollingPromise;
    }

    let trackedPromise: Promise<void>;

    trackedPromise = this.collectDueEndpoints().finally(() => {
      if (this.pollingPromise === trackedPromise) {
        this.pollingPromise = undefined;
      }
    });

    this.pollingPromise = trackedPromise;

    return trackedPromise;
  }

  /**
   * Stops future polling, prevents new executions and waits for
   * currently running health checks to settle.
   */
  async stop(): Promise<void> {
    if (!this.stopping) {
      this.stopping = true;
      this.started = false;

      if (this.timer !== undefined) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    }

    // A database discovery query may still be running.
    await this.pollingPromise;

    // Discard work that has not started.
    this.pendingEndpointIds.length = 0;
    this.queuedEndpointIds.clear();

    // Active checks are allowed to finish.
    await Promise.allSettled(
      Array.from(this.activeTasks)
    );
  }

  private async collectDueEndpoints(): Promise<void> {
    let dueEndpoints;

    try {
      dueEndpoints =
        await this.repository.findDueEndpoints(this.batchLimit);
    } catch (error) {
      this.reportFailure({
        phase: "poll",
        errorName: getErrorName(error)
      });

      return;
    }

    // Shutdown may have begun while PostgreSQL was queried.
    if (this.stopping) {
      return;
    }

    for (const endpoint of dueEndpoints) {
      const endpointId = endpoint.id;

      if (
        this.inFlightEndpointIds.has(endpointId) ||
        this.queuedEndpointIds.has(endpointId)
      ) {
        continue;
      }

      // Bound memory use if checks are slower than polling.
      if (
        this.pendingEndpointIds.length >= this.maxQueuedChecks
      ) {
        break;
      }

      this.pendingEndpointIds.push(endpointId);
      this.queuedEndpointIds.add(endpointId);
    }

    this.dispatchPendingChecks();
  }

  private dispatchPendingChecks(): void {
    while (
      !this.stopping &&
      this.inFlightEndpointIds.size < this.maxConcurrentChecks &&
      this.pendingEndpointIds.length > 0
    ) {
      const endpointId = this.pendingEndpointIds.shift();

      if (endpointId === undefined) {
        continue;
      }

      this.queuedEndpointIds.delete(endpointId);

      if (this.inFlightEndpointIds.has(endpointId)) {
        continue;
      }

      this.launchCheck(endpointId);
    }
  }

  private launchCheck(endpointId: number): void {
    this.inFlightEndpointIds.add(endpointId);

    let task: Promise<void>;

    task = Promise.resolve()
      .then(() => this.executeEndpoint(endpointId))
      .then(() => undefined)
      .catch((error: unknown) => {
        this.reportFailure({
          phase: "execution",
          endpointId,
          errorName: getErrorName(error)
        });
      })
      .finally(() => {
        this.inFlightEndpointIds.delete(endpointId);
        this.activeTasks.delete(task);

        // Continue draining queued work unless shutdown has begun.
        if (!this.stopping) {
          this.dispatchPendingChecks();
        }
      });

    this.activeTasks.add(task);
  }

  private reportFailure(
    failure: HealthCheckSchedulerFailure
  ): void {
    try {
      // Never pass raw exceptions or database messages into logs.
      this.onError(failure);
    } catch {
      // A logging callback must not terminate scheduling.
    }
  }
}