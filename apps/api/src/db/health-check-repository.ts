import { eq } from "drizzle-orm";
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

/**
 * Loads monitored endpoints and persists health-check observations.
 * HTTP execution and scheduling belong to other components.
 */
export class DrizzleHealthCheckRepository
  implements HealthCheckExecutionRepository
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