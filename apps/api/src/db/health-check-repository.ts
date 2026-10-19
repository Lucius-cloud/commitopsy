
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "./schema.js";
import {
  healthCheckResults,
  type HealthCheckOutcome
} from "./schema.js";

export interface NewHealthCheckResult {
  endpointId: number;
  outcome: HealthCheckOutcome;
  httpStatus: number | null;
  latencyMs: number;
  failureCode: string | null;
}

export type SavedHealthCheckResult =
  typeof healthCheckResults.$inferSelect;

/**
 * Persists health-check attempts against registered endpoints.
 *
 * This repository does not execute HTTP requests or schedule checks.
 * PostgreSQL remains responsible for generating the ID and checkedAt.
 */
export class DrizzleHealthCheckRepository {
  constructor(
    private readonly db: NodePgDatabase<typeof schema>
  ) {}

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
