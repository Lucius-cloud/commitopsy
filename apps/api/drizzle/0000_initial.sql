CREATE TABLE IF NOT EXISTS "github_events" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "delivery_id" text NOT NULL,
  "event_name" text NOT NULL,
  "action" text,
  "repository_id" text NOT NULL,
  "repository_full_name" text NOT NULL,
  "occurred_at" timestamp with time zone,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "commit_sha" text,
  "summary" jsonb NOT NULL,
  CONSTRAINT "github_events_event_name_check" CHECK ("event_name" IN ('push', 'workflow_run'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "github_events_delivery_id_uq" ON "github_events" USING btree ("delivery_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_events_repository_received_idx" ON "github_events" USING btree ("repository_full_name", "received_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_events_repository_occurred_idx" ON "github_events" USING btree ("repository_full_name", "occurred_at");
