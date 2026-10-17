import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import type { GithubEventRepository, NewGithubEvent } from "../src/db/event-repository.js";


const SECRET = "unit-test-secret-with-at-least-32-characters";
const DELIVERY_ID = "a8098c1a-f86e-11da-bd1a-00112444be1e";

function signPayload(rawBody: Buffer, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

class MemoryEventRepository implements GithubEventRepository {
  readonly events = new Map<string, NewGithubEvent>();

  async saveOnce(event: NewGithubEvent): Promise<boolean> {
    if (this.events.has(event.deliveryId)) return false;
    this.events.set(event.deliveryId, event);
    return true;
  }
}

function createTestContext() {
  const repository = new MemoryEventRepository();
  const app = createApp({
    githubWebhookSecret: SECRET,
    eventRepository: repository,
    readinessCheck: async () => undefined
  });
  return { app, repository };
}

function pushPayload() {
  return {
    ref: "refs/heads/main",
    before: "a".repeat(40),
    after: "b".repeat(40),
    repository: { id: 12345, full_name: "example/demo-app" },
    sender: { login: "maintainer" },
    head_commit: { timestamp: "2026-10-11T10:02:00Z" },
    commits: [
      { added: [], removed: [], modified: [".github/workflows/deploy.yml", "src/server.ts"] }
    ]
  };
}

async function postGithubEvent(
  app: ReturnType<typeof createApp>,
  payload: unknown,
  options: { deliveryId?: string; eventName?: string; signatureSecret?: string | null; rawBody?: string; signatureBody?: string;
 } = {}
) {
const rawBody = options.rawBody ?? JSON.stringify(payload);
const signatureBody = options.signatureBody ?? rawBody;

const signature = options.signatureSecret === null
  ? undefined
  : signPayload(
      Buffer.from(signatureBody),
      options.signatureSecret ?? SECRET,
    );
  let req = request(app)
    .post("/api/webhooks/github")
    .set("content-type", "application/json")
    .set("x-github-event", options.eventName ?? "push")
    .set("x-github-delivery", options.deliveryId ?? DELIVERY_ID);
  if (signature) req = req.set("x-hub-signature-256", signature);
  return req.send(rawBody);
}

describe("POST /api/webhooks/github", () => {
  it("accepts a correctly signed push and stores a minimal canonical event", async () => {
    const { app, repository } = createTestContext();
    const response = await postGithubEvent(app, pushPayload());

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ received: true, duplicate: false, deliveryId: DELIVERY_ID });
    expect(repository.events.size).toBe(1);
    const stored = repository.events.get(DELIVERY_ID);
    expect(stored?.repositoryFullName).toBe("example/demo-app");
    expect(stored?.eventName).toBe("push");
    expect(stored?.occurredAt).toBeNull();
    expect(stored?.summary.headCommitAt).toBe("2026-10-11T10:02:00.000Z");
    expect(stored?.summary.workflowFilesChanged).toEqual([".github/workflows/deploy.yml"]);
    expect(stored?.summary.commitCount).toBe(1);
    expect(stored).not.toHaveProperty("payload");
  });
  it("rejects a body that differs from the signed bytes", async () => {
  const { app, repository } = createTestContext();

  const originalBody = JSON.stringify(pushPayload());
  const modifiedBody = JSON.stringify({
    ...pushPayload(),
    ref: "refs/heads/feature",
  });

  const response = await postGithubEvent(app, pushPayload(), {
    rawBody: modifiedBody,
    signatureBody: originalBody,
  });

  expect(response.status).toBe(401);
  expect(response.body.error).toBe("invalid_webhook_signature");
  expect(repository.events.size).toBe(0);
});

  it("rejects requests without a signature", async () => {
    const { app, repository } = createTestContext();
    const response = await postGithubEvent(app, pushPayload(), { signatureSecret: null });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("invalid_webhook_signature");
    expect(repository.events.size).toBe(0);
  });

  it("rejects a signed push payload that fails schema validation", async () => {
  const { app, repository } = createTestContext();

  const response = await postGithubEvent(app, {
    repository: {
      full_name: "example/demo-app",
    },
  });

  expect(response.status).toBe(400);
  expect(response.body.error).toBe("invalid_event_payload");
  expect(repository.events.size).toBe(0);
});

  it("rejects a signature generated with the wrong secret", async () => {
    const { app } = createTestContext();
    const response = await postGithubEvent(app, pushPayload(), { signatureSecret: "wrong-secret" });
    expect(response.status).toBe(401);
  });

  it("returns a client error for malformed JSON after signature verification", async () => {
    const { app, repository } = createTestContext();
    const rawBody = "{";
    const response = await postGithubEvent(app, {}, { rawBody });
    expect(response.status).toBe(400);
    expect(repository.events.size).toBe(0);
  });

  it("does not persist the same delivery twice", async () => {
    const { app, repository } = createTestContext();
    const payload = pushPayload();
    const first = await postGithubEvent(app, payload);
    const second = await postGithubEvent(app, payload);

    expect(first.status).toBe(202);
    expect(first.body.duplicate).toBe(false);
    expect(second.status).toBe(202);
    expect(second.body.duplicate).toBe(true);
    expect(repository.events.size).toBe(1);
  });

  it("acknowledges but ignores unsupported event types", async () => {
    const { app, repository } = createTestContext();
    const response = await postGithubEvent(app, { zen: "Keep it logically awesome." }, { eventName: "ping" });
    expect(response.status).toBe(202);
    expect(response.body.ignored).toBe(true);
    expect(repository.events.size).toBe(0);
  });

  it("rejects an invalid delivery identifier", async () => {
    const { app, repository } = createTestContext();
    const response = await postGithubEvent(app, pushPayload(), { deliveryId: "not-a-uuid" });
    expect(response.status).toBe(400);
    expect(repository.events.size).toBe(0);
  });
});

describe("health endpoints", () => {
  it("returns liveness without touching the database", async () => {
    const { app } = createTestContext();
    const response = await request(app).get("/health/live");
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
  });

  it("reports readiness failure without leaking database errors", async () => {
    const app = createApp({
      githubWebhookSecret: SECRET,
      eventRepository: new MemoryEventRepository(),
      readinessCheck: async () => { throw new Error("database connection URL contains sensitive details"); }
    });
    const response = await request(app).get("/health/ready");
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: "not_ready" });
  });
});
