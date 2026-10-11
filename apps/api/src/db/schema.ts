import {
  bigserial,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export type SupportedGithubEventName = "push" | "workflow_run";

export type GithubEventSummary = Record<string, unknown>;

export const githubEvents = pgTable(
  "github_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    deliveryId: text("delivery_id").notNull(),
    eventName: text("event_name").$type<SupportedGithubEventName>().notNull(),
    action: text("action"),
    repositoryId: text("repository_id").notNull(),
    repositoryFullName: text("repository_full_name").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    commitSha: text("commit_sha"),
    summary: jsonb("summary").$type<GithubEventSummary>().notNull()
  },
  (table) => [
    uniqueIndex("github_events_delivery_id_uq").on(table.deliveryId),
    index("github_events_repository_received_idx").on(table.repositoryFullName, table.receivedAt),
    index("github_events_repository_occurred_idx").on(table.repositoryFullName, table.occurredAt),
    check("github_events_event_name_check", sql`${table.eventName} IN ('push', 'workflow_run')`)
  ]
);
