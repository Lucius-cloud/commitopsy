import { z } from "zod";
import type { NewGithubEvent } from "../db/event-repository.js";

const repositorySchema = z.object({
  id: z.union([z.number().int().positive(), z.string().min(1)]),
  full_name: z.string().min(1).max(255)
}).passthrough();

const pathChangeSchema = z.object({
  added: z.array(z.string()).optional(),
  modified: z.array(z.string()).optional(),
  removed: z.array(z.string()).optional()
}).passthrough();

const pushPayloadSchema = z.object({
  repository: repositorySchema,
  ref: z.string().optional(),
  before: z.string().optional(),
  after: z.string().optional(),
  commits: z.array(pathChangeSchema).optional(),
  head_commit: z.object({ timestamp: z.string().optional() }).passthrough().nullable().optional(),
  sender: z.object({ login: z.string().optional() }).passthrough().optional()
}).passthrough();

const workflowRunPayloadSchema = z.object({
  repository: repositorySchema,
  action: z.string().optional(),
  workflow_run: z.object({
    id: z.union([z.number().int().positive(), z.string().min(1)]),
    name: z.string().nullable().optional(),
    run_number: z.number().int().optional(),
    workflow_id: z.number().int().optional(),
    head_branch: z.string().optional(),
    head_sha: z.string().optional(),
    html_url: z.string().url().optional(),
    path: z.string().optional(),
    event: z.string().optional(),
    status: z.string().optional(),
    conclusion: z.string().nullable().optional(),
    created_at: z.string().optional(),
    run_started_at: z.string().nullable().optional(),
    updated_at: z.string().optional()
  }).passthrough(),
  sender: z.object({ login: z.string().optional() }).passthrough().optional()
}).passthrough();

function validDateOrNull(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function workflowPaths(payload: z.infer<typeof pushPayloadSchema>): string[] {
  const allPaths = (payload.commits ?? []).flatMap((commit) => [
    ...(commit.added ?? []),
    ...(commit.modified ?? []),
    ...(commit.removed ?? [])
  ]);
  return [...new Set(allPaths.filter((path) => path.startsWith(".github/workflows/")))].sort();
}

export function normalizeGithubEvent(
  eventName: string,
  deliveryId: string,
  payloadValue: unknown
): NewGithubEvent | null {
  if (eventName === "push") {
    const parsed = pushPayloadSchema.safeParse(payloadValue);
    if (!parsed.success) throw new InvalidGithubPayloadError("Invalid push event payload");
    const payload = parsed.data;

    return {
      deliveryId,
      eventName: "push",
      action: null,
      repositoryId: String(payload.repository.id),
      repositoryFullName: payload.repository.full_name,
      // GitHub push payloads do not provide a reliable push-event timestamp.
      // Keep occurred_at NULL; preserve the commit timestamp as a separate fact.
      occurredAt: null,
      commitSha: payload.after && payload.after !== "0000000000000000000000000000000000000000" ? payload.after : null,
      summary: {
        ref: payload.ref ?? null,
        before: payload.before ?? null,
        after: payload.after ?? null,
        workflowFilesChanged: workflowPaths(payload),
        headCommitAt: validDateOrNull(payload.head_commit?.timestamp)?.toISOString() ?? null,
        commitCount: payload.commits?.length ?? 0,
        senderLogin: payload.sender?.login ?? null
      }
    };
  }

  if (eventName === "workflow_run") {
    const parsed = workflowRunPayloadSchema.safeParse(payloadValue);
    if (!parsed.success) throw new InvalidGithubPayloadError("Invalid workflow_run event payload");
    const payload = parsed.data;
    const run = payload.workflow_run;

    return {
      deliveryId,
      eventName: "workflow_run",
      action: payload.action ?? null,
      repositoryId: String(payload.repository.id),
      repositoryFullName: payload.repository.full_name,
      occurredAt: validDateOrNull(
        payload.action === "completed"
          ? run.updated_at ?? run.run_started_at ?? run.created_at
          : run.run_started_at ?? run.created_at
      ),
      commitSha: run.head_sha ?? null,
      summary: {
        runId: String(run.id),
        workflowId: run.workflow_id ?? null,
        workflowName: run.name ?? null,
        runNumber: run.run_number ?? null,
        branch: run.head_branch ?? null,
        workflowPath: run.path ?? null,
        triggeringEvent: run.event ?? null,
        status: run.status ?? null,
        conclusion: run.conclusion ?? null,
        runCreatedAt: validDateOrNull(run.created_at)?.toISOString() ?? null,
        runStartedAt: validDateOrNull(run.run_started_at)?.toISOString() ?? null,
        runUpdatedAt: validDateOrNull(run.updated_at)?.toISOString() ?? null,
        htmlUrl: run.html_url ?? null,
        senderLogin: payload.sender?.login ?? null
      }
    };
  }

  return null;
}

export class InvalidGithubPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGithubPayloadError";
  }
}
