
import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import * as schema from "../../src/db/schema.js";
import {
  healthCheckResults,
  monitoredEndpoints
} from "../../src/db/schema.js";
import { DrizzleHealthCheckRepository } from "../../src/db/health-check-repository.js";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is required for PostgreSQL integration tests"
  );
}

const parsedDatabaseUrl = new URL(databaseUrl);
const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

if (
  !localHosts.has(parsedDatabaseUrl.hostname) ||
  parsedDatabaseUrl.pathname !== "/commitopsy_dev"
) {
  throw new Error(
    "Integration tests may only use the local commitopsy_dev database"
  );
}

const pool = new Pool({
  connectionString: databaseUrl,
  max: 5,
  connectionTimeoutMillis: 5_000
});

const db = drizzle(pool, { schema });
const repository = new DrizzleHealthCheckRepository(db);

let databaseReady = false;
let endpointId: number | undefined;
const resultIds: number[] = [];

describe("Health-check PostgreSQL integration", () => {
  beforeAll(async () => {
    await pool.query("SELECT 1 FROM monitored_endpoints LIMIT 0");
    await pool.query("SELECT 1 FROM health_check_results LIMIT 0");
    databaseReady = true;
  });

  afterAll(async () => {
    try {
      if (databaseReady) {
        if (resultIds.length > 0) {
          await db
            .delete(healthCheckResults)
            .where(inArray(healthCheckResults.id, resultIds));
        }

        if (endpointId !== undefined) {
          await db
            .delete(monitoredEndpoints)
            .where(eq(monitoredEndpoints.id, endpointId));
        }
      }
    } finally {
      await pool.end();
    }
  });

  it("persists healthy and unhealthy results for a monitored endpoint", async () => {
    const endpoints = await db
      .insert(monitoredEndpoints)
      .values({
        name: "Commitopsy health-check integration test",
        url: `https://${randomUUID()}.example.invalid/health`,
        intervalSeconds: 60,
        enabled: true
      })
      .returning({ id: monitoredEndpoints.id });

    const endpoint = endpoints[0];

    if (!endpoint) {
      throw new Error("Test endpoint was not created");
    }

    endpointId = endpoint.id;

    const healthy = await repository.saveResult({
      endpointId,
      outcome: "healthy",
      httpStatus: 204,
      latencyMs: 42,
      failureCode: null
    });

    resultIds.push(healthy.id);

    const unhealthy = await repository.saveResult({
      endpointId,
      outcome: "unhealthy",
      httpStatus: 503,
      latencyMs: 125,
      failureCode: "http_error"
    });

    resultIds.push(unhealthy.id);

    expect(healthy).toMatchObject({
      endpointId,
      outcome: "healthy",
      httpStatus: 204,
      latencyMs: 42,
      failureCode: null
    });

    expect(healthy.checkedAt).toBeInstanceOf(Date);
    expect(healthy.id).toBeGreaterThan(0);

    expect(unhealthy).toMatchObject({
      endpointId,
      outcome: "unhealthy",
      httpStatus: 503,
      latencyMs: 125,
      failureCode: "http_error"
    });

    expect(unhealthy.checkedAt).toBeInstanceOf(Date);
    expect(unhealthy.id).toBeGreaterThan(healthy.id);

    // Verify persisted PostgreSQL state, not just the insert response.
    const rows = await db
      .select()
      .from(healthCheckResults)
      .where(eq(healthCheckResults.endpointId, endpointId))
      .orderBy(asc(healthCheckResults.id));

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.id)).toEqual([
      healthy.id,
      unhealthy.id
    ]);
  });
});
