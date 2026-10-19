import {
  bigserial,
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export type SupportedGithubEventName = "push" | "workflow_run";

export type GithubEventSummary = Record<string, unknown>;

export type HealthCheckOutcome = "healthy" | "unhealthy";

export const githubEvents = pgTable(
  "github_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    deliveryId: text("delivery_id").notNull(),
    eventName: text("event_name").$type<SupportedGithubEventName>().notNull(),
    action: text("action"),
    repositoryId: text("repository_id").notNull(),
    repositoryFullName: text("repository_full_name").notNull(),
    occurredAt: timestamp("occurred_at", {
      withTimezone: true,
      mode: "date"
    }),
    receivedAt: timestamp("received_at", {
      withTimezone: true,
      mode: "date"
    }).notNull().defaultNow(),
    commitSha: text("commit_sha"),
    summary: jsonb("summary").$type<GithubEventSummary>().notNull()
  },
  (table) => [
    uniqueIndex("github_events_delivery_id_uq").on(table.deliveryId),
    index("github_events_repository_received_idx").on(
      table.repositoryFullName,
      table.receivedAt
    ),
    index("github_events_repository_occurred_idx").on(
      table.repositoryFullName,
      table.occurredAt
    ),
    check(
      "github_events_event_name_check",
      sql`${table.eventName} IN ('push', 'workflow_run')`
    )
  ]
);

/**
 * Configuration for an application that Commitopsy monitors.
 * URL safety must also be enforced by the application before any request.
 */
export const monitoredEndpoints = pgTable(
  "monitored_endpoints",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    intervalSeconds: integer("interval_seconds").notNull().default(60),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date"
    }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("monitored_endpoints_url_uq").on(table.url),
    index("monitored_endpoints_enabled_idx").on(table.enabled),
    check(
      "monitored_endpoints_name_check",
      sql`length(trim(${table.name})) BETWEEN 1 AND 100`
    ),
    check(
      "monitored_endpoints_https_url_check",
      sql`${table.url} LIKE 'https://%'`
    ),
    check(
      "monitored_endpoints_interval_check",
      sql`${table.intervalSeconds} BETWEEN 30 AND 3600`
    )
  ]
);

/**
 * One record per health-check attempt.
 * Store stable failure codes, not raw exceptions or response bodies.
 */
export const healthCheckResults = pgTable(
  "health_check_results",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    endpointId: bigint("endpoint_id", { mode: "number" })
      .notNull()
      .references(() => monitoredEndpoints.id),
    checkedAt: timestamp("checked_at", {
      withTimezone: true,
      mode: "date"
    }).notNull().defaultNow(),
    outcome: text("outcome").$type<HealthCheckOutcome>().notNull(),
    httpStatus: integer("http_status"),
    latencyMs: integer("latency_ms").notNull(),
    failureCode: text("failure_code")
  },
  (table) => [
    index("health_check_results_endpoint_checked_idx").on(
      table.endpointId,
      table.checkedAt
    ),
    check(
      "health_check_results_outcome_check",
      sql`${table.outcome} IN ('healthy', 'unhealthy')`
    ),
    check(
      "health_check_results_latency_check",
      sql`${table.latencyMs} >= 0`
    ),
    check(
      "health_check_results_http_status_check",
      sql`${table.httpStatus} IS NULL OR ${table.httpStatus} BETWEEN 100 AND 599`
    )
  ]
);
