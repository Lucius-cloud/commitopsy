import "dotenv/config";

import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";

import * as schema from "../../src/db/schema.js";
import { createApp } from "../../src/app.js";
import { DrizzleGithubEventRepository } from "../../src/db/event-repository.js";
import { githubEvents } from "../../src/db/schema.js";
const databaseUrl = process.env.DATABASE_URL;
const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
}

if (!webhookSecret || webhookSecret.length < 32) {
  throw new Error("A valid local GITHUB_WEBHOOK_SECRET is required");
}

// Safety guard: these tests may write and clean up test records.
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
  max: 2,
  connectionTimeoutMillis: 5_000
});

const db = drizzle(pool, { schema });

const repository = new DrizzleGithubEventRepository(db);

const app = createApp({
  githubWebhookSecret: webhookSecret,
  eventRepository: repository,
  readinessCheck: async () => {
    await pool.query("SELECT 1");
  }
});

const deliveryId = randomUUID();

const payload = {
  ref: "refs/heads/main",
  before: "a".repeat(40),
  after: "b".repeat(40),
  repository: {
    id: 987654321,
    full_name: "commitopsy-integration/idempotency-test"
  },
  sender: {
    login: "commitopsy-integration-test"
  },
  head_commit: {
    timestamp: "2026-10-15T10:00:00.000Z"
  },
  commits: [
    {
      added: [],
      removed: [],
      modified: [".github/workflows/deploy.yml"]
    }
  ]
};

const rawBody = JSON.stringify(payload);

const signature = `sha256=${createHmac("sha256", webhookSecret)
  .update(Buffer.from(rawBody))
  .digest("hex")}`;

function sendSignedWebhook() {
  return request(app)
    .post("/api/webhooks/github")
    .set("content-type", "application/json")
    .set("x-github-event", "push")
    .set("x-github-delivery", deliveryId)
    .set("x-hub-signature-256", signature)
    .send(rawBody);
}
let databaseReady = false;

describe("GitHub webhook PostgreSQL integration", () => {
  beforeAll(async () => {
  // Verify that PostgreSQL and the migrated table are available.
  await pool.query("SELECT 1 FROM github_events LIMIT 0");
  databaseReady = true;
});

afterAll(async () => {
  try {
    // Don't query the database if the initial readiness check failed.
    if (databaseReady) {
      await db
        .delete(githubEvents)
        .where(eq(githubEvents.deliveryId, deliveryId));
    }
  } finally {
    // Always close the pool, including when setup fails.
    await pool.end();
  }
});

  it("persists a signed event once, even when the delivery is replayed", async () => {
    const firstResponse = await sendSignedWebhook();

    expect(firstResponse.status).toBe(202);
    expect(firstResponse.body).toMatchObject({
      received: true,
      duplicate: false,
      deliveryId
    });

    const firstRows = await db
      .select()
      .from(githubEvents)
      .where(eq(githubEvents.deliveryId, deliveryId));

    expect(firstRows).toHaveLength(1);
    expect(firstRows[0]).toMatchObject({
      deliveryId,
      eventName: "push",
      repositoryId: "987654321",
      repositoryFullName: "commitopsy-integration/idempotency-test"
    });

    expect(firstRows[0]?.summary.workflowFilesChanged).toEqual([
      ".github/workflows/deploy.yml"
    ]);

    // Re-send the exact same body, signature and delivery ID.
    const secondResponse = await sendSignedWebhook();

    expect(secondResponse.status).toBe(202);
    expect(secondResponse.body).toMatchObject({
      received: true,
      duplicate: true,
      deliveryId
    });

    const finalRows = await db
      .select()
      .from(githubEvents)
      .where(eq(githubEvents.deliveryId, deliveryId));

    expect(finalRows).toHaveLength(1);
    expect(finalRows[0]?.id).toBe(firstRows[0]?.id);
  });
});