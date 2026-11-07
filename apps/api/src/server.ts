import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

import * as schema from "./db/schema.js";

import { DrizzleGithubEventRepository } from "./db/event-repository.js";
import { DrizzleHealthCheckRepository } from "./db/health-check-repository.js";

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

import {
  executeHealthCheckWithRealChecker
} from "./health-check/execute-health-check.js";

import {
  HealthCheckScheduler
} from "./health-check/health-check-scheduler.js";

async function main() {
  const config = loadConfig();

  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 5_000
  });

  const db = drizzle(pool, { schema });

  const eventRepository =
    new DrizzleGithubEventRepository(db);

  const healthCheckRepository =
    new DrizzleHealthCheckRepository(db);

  const healthCheckScheduler = new HealthCheckScheduler({
    repository: healthCheckRepository,

    executeEndpoint: (endpointId) =>
      executeHealthCheckWithRealChecker(
        endpointId,
        healthCheckRepository
      ),

    pollingIntervalMs: config.HEALTH_CHECK_POLL_INTERVAL_MS,

    maxConcurrentChecks:
      config.HEALTH_CHECK_MAX_CONCURRENT_CHECKS,

    batchLimit: config.HEALTH_CHECK_BATCH_LIMIT
  });

  const app = createApp({
    githubWebhookSecret: config.GITHUB_WEBHOOK_SECRET,
    eventRepository,

    readinessCheck: async () => {
      await pool.query("SELECT 1");
    }
  });

  const server = app.listen(config.PORT, () => {
    healthCheckScheduler.start();

    console.info(
      JSON.stringify({
        level: "info",
        message: "Commitopsy API listening",
        port: config.PORT,
        env: config.NODE_ENV,
        healthCheckScheduler: {
          enabled: true,
          pollingIntervalMs:
            config.HEALTH_CHECK_POLL_INTERVAL_MS,
          maxConcurrentChecks:
            config.HEALTH_CHECK_MAX_CONCURRENT_CHECKS,
          batchLimit: config.HEALTH_CHECK_BATCH_LIMIT,
          coordination: "single_process"
        }
      })
    );
  });

  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;

    console.info(
      JSON.stringify({
        level: "info",
        message: "Graceful shutdown requested",
        signal
      })
    );

    const forceExitTimer = setTimeout(() => {
      console.error(
        JSON.stringify({
          level: "error",
          message: "Graceful shutdown timed out"
        })
      );

      process.exit(1);
    }, 10_000);

    forceExitTimer.unref();

    // Stop accepting new HTTP connections.
    const serverClosed = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    void (async () => {
      try {
        // Stop new scheduled work and drain active health checks.
        const results = await Promise.allSettled([
          healthCheckScheduler.stop(),
          serverClosed
        ]);

        await pool.end();

        const failures = results.filter(
          (result) => result.status === "rejected"
        );

        clearTimeout(forceExitTimer);

        if (failures.length > 0) {
          console.error(
            JSON.stringify({
              level: "error",
              message: "One or more shutdown operations failed",
              failureCount: failures.length
            })
          );

          process.exitCode = 1;
          return;
        }

        console.info(
          JSON.stringify({
            level: "info",
            message: "Commitopsy shutdown completed"
          })
        );
      } catch (error) {
        clearTimeout(forceExitTimer);

        console.error(
          JSON.stringify({
            level: "error",
            message: "Commitopsy shutdown failed",
            errorName:
              error instanceof Error ? error.name : "UnknownError"
          })
        );

        process.exitCode = 1;
      }
    })();
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Unknown startup error";

  console.error(
    JSON.stringify({
      level: "error",
      message: "Commitopsy API startup failed",
      detail: message
    })
  );

  process.exitCode = 1;
});