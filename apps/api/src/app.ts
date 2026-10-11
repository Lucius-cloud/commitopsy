import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import type { GithubEventRepository } from "./db/event-repository.js";
import { createGithubWebhookRouter } from "./webhooks/github-router.js";

export interface AppDependencies {
  githubWebhookSecret: string;
  eventRepository: GithubEventRepository;
  readinessCheck?: () => Promise<void>;
}

export function createApp(dependencies: AppDependencies) {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());

  // Register the raw-body webhook route before any JSON body parser.
  app.use("/api/webhooks", createGithubWebhookRouter({
    secret: dependencies.githubWebhookSecret,
    events: dependencies.eventRepository
  }));

  app.get("/health/live", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/health/ready", async (_req, res) => {
    try {
      await dependencies.readinessCheck?.();
      res.status(200).json({ status: "ready" });
    } catch {
      res.status(503).json({ status: "not_ready" });
    }
  });

  app.use(express.json({ limit: "100kb" }));

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  // Avoid returning exception messages, SQL details, or request payloads to clients.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = typeof error === "object" && error !== null && "status" in error
      && typeof error.status === "number" ? error.status : 500;
    if (status === 413) {
      res.status(413).json({ error: "payload_too_large" });
      return;
    }
    if (status >= 400 && status < 500) {
      res.status(status).json({ error: "invalid_request" });
      return;
    }
    res.status(500).json({ error: "internal_server_error" });
  });

  return app;
}
