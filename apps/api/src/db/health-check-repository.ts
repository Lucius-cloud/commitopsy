
import {
  and,
  asc,
  eq,
  gt,
  notExists,
  sql
} from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "./schema.js";
import {
  healthCheckResults,
  monitoredEndpoints,
  type HealthCheckOutcome
} from "./schema.js";

export interface MonitoredEndpointForHealthCheck {
  id: number;
  url: string;
  enabled: boolean;
}

export interface DueMonitoredEndpoint {
  id: number;
  intervalSeconds: number;
}

export interface NewHealthCheckResult {
  endpointId: number;
  outcome: HealthCheckOutcome;
  httpStatus: number | null;
  latencyMs: number;
  failureCode: string | null;
}

export type SavedHealthCheckResult =
  typeof healthCheckResults.$inferSelect;

export interface HealthCheckExecutionRepository {
  findEndpointById(
    endpointId: number
  ): Promise<MonitoredEndpointForHealthCheck | null>;

  saveResult(
    result: NewHealthCheckResult
  ): Promise<SavedHealthCheckResult>;
}

export interface HealthCheckSchedulingRepository
  extends HealthCheckExecutionRepository {
  findDueEndpoints(
    limit: number
  ): Promise<DueMonitoredEndpoint[]>;
}

export class DrizzleHealthCheckRepository
  implements HealthCheckSchedulingRepository
{
  constructor(
    private readonly db: NodePgDatabase<typeof schema>
  ) {}

  async findEndpointById(
    endpointId: number
  ): Promise<MonitoredEndpointForHealthCheck | null> {
    const [endpoint] = await this.db
      .select({
        id: monitoredEndpoints.id,
        url: monitoredEndpoints.url,
        enabled: monitoredEndpoints.enabled
      })
      .from(monitoredEndpoints)
      .where(eq(monitoredEndpoints.id, endpointId))
      .limit(1);

    return endpoint ?? null;
  }

  /**
   * Returns enabled endpoints without a check result inside
   * their configured interval, including endpoints never checked.
   *
   * Uses PostgreSQL's clock for consistent cutoff comparisons.
   * This discovers due work; it does not claim or execute it.
   */
  async findDueEndpoints(
    limit: number
  ): Promise<DueMonitoredEndpoint[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new RangeError(
        "limit must be an integer between 1 and 500"
      );
    }

    const recentCheck = this.db
      .select({
        id: healthCheckResults.id
      })
      .from(healthCheckResults)
      .where(
        and(
          eq(
            healthCheckResults.endpointId,
            monitoredEndpoints.id
          ),
          gt(
            healthCheckResults.checkedAt,
            sql`now() - (${monitoredEndpoints.intervalSeconds} * interval '1 second')`
          )
        )
      );

    return this.db
      .select({
        id: monitoredEndpoints.id,
        intervalSeconds: monitoredEndpoints.intervalSeconds
      })
      .from(monitoredEndpoints)
      .where(
        and(
          eq(monitoredEndpoints.enabled, true),
          notExists(recentCheck)
        )
      )
      .orderBy(asc(monitoredEndpoints.id))
      .limit(limit);
  }

  async saveResult(
    result: NewHealthCheckResult
  ): Promise<SavedHealthCheckResult> {
    const [saved] = await this.db
      .insert(healthCheckResults)
      .values(result)
      .returning();

    if (!saved) {
      throw new Error("Health-check result was not persisted");
    }

    return saved;
  }
}
