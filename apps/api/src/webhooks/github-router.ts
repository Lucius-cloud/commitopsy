import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { ZodError, z } from "zod";
import type { GithubEventRepository } from "../db/event-repository.js";
import { InvalidGithubPayloadError, normalizeGithubEvent } from "../github/normalize-event.js";
import { verifyGithubSignature } from "../github/signature.js";

const deliveryIdSchema = z.string().uuid();
const acceptedEventNames = new Set(["push", "workflow_run"]);

export interface GithubWebhookDependencies {
  secret: string;
  events: GithubEventRepository;
}

export function createGithubWebhookRouter(dependencies: GithubWebhookDependencies): Router {
  const router = express.Router();

  router.post(
    "/github",
    express.raw({ type: "application/json", limit: "1mb" }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
          res.status(400).json({ error: "invalid_request_body" });
          return;
        }

        const signature = req.get("x-hub-signature-256") ?? undefined;
        if (!verifyGithubSignature(req.body, signature, dependencies.secret)) {
          res.status(401).json({ error: "invalid_webhook_signature" });
          return;
        }

        const deliveryId = deliveryIdSchema.safeParse(req.get("x-github-delivery"));
        if (!deliveryId.success) {
          res.status(400).json({ error: "invalid_or_missing_delivery_id" });
          return;
        }

        const eventName = req.get("x-github-event");
        if (!eventName) {
          res.status(400).json({ error: "missing_github_event_header" });
          return;
        }

        let payload: unknown;
        try {
          payload = JSON.parse(req.body.toString("utf8")) as unknown;
        } catch {
          res.status(400).json({ error: "invalid_json_payload" });
          return;
        }

        if (eventName === "ping" || !acceptedEventNames.has(eventName)) {
          res.status(202).json({ received: true, ignored: true, reason: "unsupported_event", deliveryId: deliveryId.data });
          return;
        }

        const canonicalEvent = normalizeGithubEvent(eventName, deliveryId.data, payload);
        if (!canonicalEvent) {
          res.status(202).json({ received: true, ignored: true, reason: "unsupported_event", deliveryId: deliveryId.data });
          return;
        }

        const inserted = await dependencies.events.saveOnce(canonicalEvent);
        res.status(202).json({
          received: true,
          duplicate: !inserted,
          deliveryId: deliveryId.data
        });
      } catch (error) {
        if (error instanceof InvalidGithubPayloadError || error instanceof ZodError) {
          res.status(400).json({ error: "invalid_event_payload" });
          return;
        }
        next(error);
      }
    }
  );

  return router;
}
