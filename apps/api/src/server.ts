import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./db/schema.js";
import { DrizzleGithubEventRepository } from "./db/event-repository.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

async function main() {
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.DATABASE_URL, max: 10, connectionTimeoutMillis: 5_000 });
  const db = drizzle(pool, { schema });
  const eventRepository = new DrizzleGithubEventRepository(db);
  const app = createApp({
    githubWebhookSecret: config.GITHUB_WEBHOOK_SECRET,
    eventRepository,
    readinessCheck: async () => {
      await pool.query("SELECT 1");
    }
  });

  const server = app.listen(config.PORT, () => {
    console.info(JSON.stringify({ level: "info", message: "Commitopsy API listening", port: config.PORT, env: config.NODE_ENV }));
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(JSON.stringify({ level: "info", message: "Shutdown requested", signal }));
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown startup error";
  // Configuration errors are safe to report because values are never included in the message.
  console.error(JSON.stringify({ level: "error", message: "Commitopsy API startup failed", detail: message }));
  process.exitCode = 1;
});
