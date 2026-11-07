import {
  afterEach,
  describe,
  expect,
  it,
  vi
} from "vitest";

import type {
  DueMonitoredEndpoint,
  HealthCheckSchedulingRepository
} from "../src/db/health-check-repository.js";

import {
  HealthCheckScheduler,
  type HealthCheckSchedulerFailure
} from "../src/health-check/health-check-scheduler.js";

type SchedulerRepository = Pick<
  HealthCheckSchedulingRepository,
  "findDueEndpoints"
>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

function createRepository(endpoints: DueMonitoredEndpoint[]) {
  const findDueEndpoints = vi.fn(
    async (_limit: number): Promise<DueMonitoredEndpoint[]> =>
      endpoints
  );

  const repository: SchedulerRepository = {
    findDueEndpoints
  };

  return { repository, findDueEndpoints };
}

function createScheduler(
  repository: SchedulerRepository,
  executeEndpoint: (endpointId: number) => Promise<unknown>,
  options?: {
    maxConcurrentChecks?: number;
    onError?: (failure: HealthCheckSchedulerFailure) => void;
  }
): HealthCheckScheduler {
  return new HealthCheckScheduler({
    repository,
    executeEndpoint,
    pollingIntervalMs: 1_000,
    maxConcurrentChecks:
      options?.maxConcurrentChecks ?? 2,
    batchLimit: 100,
    onError: options?.onError
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("HealthCheckScheduler", () => {
  it("immediately executes endpoints discovered as due", async () => {
    const { repository, findDueEndpoints } = createRepository([
      { id: 1, intervalSeconds: 60 },
      { id: 2, intervalSeconds: 120 }
    ]);

    const executeEndpoint = vi.fn(
      async (_endpointId: number) => undefined
    );

    const scheduler = createScheduler(
      repository,
      executeEndpoint
    );

    scheduler.start();

    await scheduler.pollNow();
    await flushMicrotasks();

    expect(findDueEndpoints).toHaveBeenCalledWith(100);

    expect(executeEndpoint).toHaveBeenCalledTimes(2);
    expect(executeEndpoint).toHaveBeenCalledWith(1);
    expect(executeEndpoint).toHaveBeenCalledWith(2);

    await scheduler.stop();
  });

  it("does not execute the same endpoint twice concurrently", async () => {
    const { repository, findDueEndpoints } = createRepository([
      { id: 10, intervalSeconds: 60 }
    ]);

    const execution = deferred<void>();

    const executeEndpoint = vi.fn(
      () => execution.promise
    );

    const scheduler = createScheduler(
      repository,
      executeEndpoint
    );

    scheduler.start();

    await scheduler.pollNow();
    await flushMicrotasks();

    expect(executeEndpoint).toHaveBeenCalledTimes(1);

    // Simulate another scheduler tick while the first check is running.
    await scheduler.pollNow();
    await flushMicrotasks();

    expect(findDueEndpoints).toHaveBeenCalledTimes(2);
    expect(executeEndpoint).toHaveBeenCalledTimes(1);

    const stopPromise = scheduler.stop();

    let stopped = false;

    void stopPromise.then(() => {
      stopped = true;
    });

    await flushMicrotasks();

    // Shutdown must wait for the active check.
    expect(stopped).toBe(false);

    execution.resolve();

    await stopPromise;

    expect(stopped).toBe(true);
  });

  it("never exceeds the configured concurrency limit", async () => {
    const { repository } = createRepository([
      { id: 1, intervalSeconds: 60 },
      { id: 2, intervalSeconds: 60 },
      { id: 3, intervalSeconds: 60 }
    ]);

    const executions = new Map<number, Deferred<void>>([
      [1, deferred<void>()],
      [2, deferred<void>()],
      [3, deferred<void>()]
    ]);

    const startedEndpointIds: number[] = [];

    const executeEndpoint = vi.fn((endpointId: number) => {
      startedEndpointIds.push(endpointId);

      const execution = executions.get(endpointId);

      if (!execution) {
        throw new Error("Unexpected endpoint ID");
      }

      return execution.promise;
    });

    const scheduler = createScheduler(
      repository,
      executeEndpoint,
      { maxConcurrentChecks: 2 }
    );

    scheduler.start();

    await scheduler.pollNow();
    await flushMicrotasks();

    expect(startedEndpointIds).toEqual([1, 2]);

    // Completing one job should release exactly one slot.
    executions.get(1)?.resolve();

    await flushMicrotasks();

    expect(startedEndpointIds).toEqual([1, 2, 3]);

    executions.get(2)?.resolve();
    executions.get(3)?.resolve();

    await scheduler.stop();
  });

  it("isolates endpoint execution failures", async () => {
    const { repository } = createRepository([
      { id: 1, intervalSeconds: 60 },
      { id: 2, intervalSeconds: 60 }
    ]);

    const failures: HealthCheckSchedulerFailure[] = [];

    const executeEndpoint = vi.fn(
      async (endpointId: number) => {
        if (endpointId === 1) {
          throw new Error("Simulated execution failure");
        }
      }
    );

    const scheduler = createScheduler(
      repository,
      executeEndpoint,
      {
        onError: (failure) => failures.push(failure)
      }
    );

    scheduler.start();

    await scheduler.pollNow();
    await flushMicrotasks();

    expect(executeEndpoint).toHaveBeenCalledTimes(2);

    expect(failures).toContainEqual({
      phase: "execution",
      endpointId: 1,
      errorName: "Error"
    });

    await scheduler.stop();
  });

  it("recovers from a failed database poll on the next scheduled tick", async () => {
    vi.useFakeTimers();

    const findDueEndpoints = vi.fn(
      async (_limit: number): Promise<DueMonitoredEndpoint[]> => []
    );

    findDueEndpoints
      .mockRejectedValueOnce(
        new Error("Simulated database failure")
      )
      .mockResolvedValueOnce([
        { id: 20, intervalSeconds: 60 }
      ]);

    const repository: SchedulerRepository = {
      findDueEndpoints
    };

    const failures: HealthCheckSchedulerFailure[] = [];

    const executeEndpoint = vi.fn(
      async (_endpointId: number) => undefined
    );

    const scheduler = new HealthCheckScheduler({
      repository,
      executeEndpoint,
      pollingIntervalMs: 1_000,
      maxConcurrentChecks: 2,
      batchLimit: 100,
      onError: (failure) => failures.push(failure)
    });

    scheduler.start();

    // The first immediate poll fails.
    await scheduler.pollNow();

    expect(findDueEndpoints).toHaveBeenCalledTimes(1);

    expect(failures).toContainEqual({
      phase: "poll",
      errorName: "Error"
    });

    // The next scheduled poll should recover.
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    expect(findDueEndpoints).toHaveBeenCalledTimes(2);
    expect(executeEndpoint).toHaveBeenCalledWith(20);

    await scheduler.stop();
  });

  it("stops polling and drains active checks during shutdown", async () => {
    vi.useFakeTimers();

    const { repository, findDueEndpoints } = createRepository([
      { id: 30, intervalSeconds: 60 }
    ]);

    const execution = deferred<void>();

    const executeEndpoint = vi.fn(
      () => execution.promise
    );

    const scheduler = createScheduler(
      repository,
      executeEndpoint
    );

    scheduler.start();

    await scheduler.pollNow();
    await flushMicrotasks();

    const stopPromise = scheduler.stop();

    let stopped = false;

    void stopPromise.then(() => {
      stopped = true;
    });

    // No additional polling should happen after shutdown begins.
    await vi.advanceTimersByTimeAsync(5_000);

    expect(findDueEndpoints).toHaveBeenCalledTimes(1);
    expect(executeEndpoint).toHaveBeenCalledTimes(1);

    // The scheduler must still be waiting for the running check.
    expect(stopped).toBe(false);

    execution.resolve();

    await stopPromise;

    expect(stopped).toBe(true);
  });

  it("does not create multiple polling timers when started repeatedly", async () => {
    vi.useFakeTimers();

    const { repository, findDueEndpoints } = createRepository([]);

    const scheduler = createScheduler(
      repository,
      async () => undefined
    );

    scheduler.start();
    scheduler.start();

    await scheduler.pollNow();

    expect(findDueEndpoints).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(findDueEndpoints).toHaveBeenCalledTimes(2);

    await scheduler.stop();
  });

  it("rejects invalid scheduler configuration", () => {
    const { repository } = createRepository([]);

    expect(
      () =>
        new HealthCheckScheduler({
          repository,
          executeEndpoint: async () => undefined,
          pollingIntervalMs: 0,
          maxConcurrentChecks: 2,
          batchLimit: 100
        })
    ).toThrow(RangeError);
  });
});