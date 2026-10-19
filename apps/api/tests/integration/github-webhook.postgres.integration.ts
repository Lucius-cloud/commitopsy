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
  throw new Error(
    "DATABASE_URL is required for PostgreSQL integration tests"
  );
}

if (!webhookSecret || webhookSecret.length < 32) {
  throw new Error("A valid local GITHUB_WEBHOOK_SECRET is required");
}

// Safety guard: this integration test may write and delete database records.
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

// Allow concurrent HTTP requests to use separate PostgreSQL connections.
const pool = new Pool({
  connectionString: databaseUrl,
  max: 10,
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

// Use separate delivery IDs so the two tests cannot affect each other.
const deliveryId = randomUUID();
const concurrentDeliveryId = randomUUID();

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

// GitHub's signature authenticates the request body, not the delivery ID.
const signature = `sha256=${createHmac("sha256", webhookSecret)
  .update(Buffer.from(rawBody))
  .digest("hex")}`;

function sendSignedWebhook(requestDeliveryId: string = deliveryId) {
  return request(app)
    .post("/api/webhooks/github")
    .set("content-type", "application/json")
    .set("x-github-event", "push")
    .set("x-github-delivery", requestDeliveryId)
    .set("x-hub-signature-256", signature)
    .send(rawBody);
}

let databaseReady = false;

describe("GitHub webhook PostgreSQL integration", () => {
  beforeAll(async () => {
    // Verify PostgreSQL connectivity and that migrations created the table.
    await pool.query("SELECT 1 FROM github_events LIMIT 0");
    databaseReady = true;
  });

  afterAll(async () => {
    try {
      // Only delete rows created by these tests.
      // Skip database cleanup if the initial readiness check failed.
      if (databaseReady) {
        await db
          .delete(githubEvents)
          .where(eq(githubEvents.deliveryId, deliveryId));

        await db
          .delete(githubEvents)
          .where(eq(githubEvents.deliveryId, concurrentDeliveryId));
      }
    } finally {
      // Always release PostgreSQL connections.
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

    // Replay the exact body, signature and delivery ID.
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

  it("persists concurrent duplicate deliveries exactly once", async () => {
    const requestCount = 10;

    // Launch all ten requests without awaiting any individual request.
    // They share the same body, signature and delivery ID.
    const responses = await Promise.all(
      Array.from({ length: requestCount }, () =>
        sendSignedWebhook(concurrentDeliveryId)
      )
    );

    // Every request should receive the documented acknowledgement.
    expect(responses).toHaveLength(requestCount);

    expect(
      responses.every((response) => response.status === 202)
    ).toBe(true);

    // Every response should acknowledge receipt of the same delivery.
    expect(
      responses.every(
        (response) =>
          response.body.received === true &&
          response.body.deliveryId === concurrentDeliveryId
      )
    ).toBe(true);

    // Exactly one concurrent request must insert the event.
    expect(
      responses.filter((response) => response.body.duplicate === false)
    ).toHaveLength(1);

    // The other nine requests must be identified as duplicates.
    expect(
      responses.filter((response) => response.body.duplicate === true)
    ).toHaveLength(requestCount - 1);

    // Verify the actual PostgreSQL state, not just the HTTP responses.
    const rows = await db
      .select()
      .from(githubEvents)
      .where(eq(githubEvents.deliveryId, concurrentDeliveryId));

    expect(rows).toHaveLength(1);

    expect(rows[0]).toMatchObject({
      deliveryId: concurrentDeliveryId,
      eventName: "push",
      repositoryId: "987654321",
      repositoryFullName: "commitopsy-integration/idempotency-test"
    });
  });
});