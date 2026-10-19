CREATE TABLE "monitored_endpoints" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "name" text NOT NULL,
    "url" text NOT NULL,
    "interval_seconds" integer DEFAULT 60 NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "monitored_endpoints_name_check"
        CHECK (length(trim("name")) BETWEEN 1 AND 100),
    CONSTRAINT "monitored_endpoints_https_url_check"
        CHECK ("url" LIKE 'https://%'),
    CONSTRAINT "monitored_endpoints_interval_check"
        CHECK ("interval_seconds" BETWEEN 30 AND 3600)
);
--> statement-breakpoint

CREATE TABLE "health_check_results" (
    "id" bigserial PRIMARY KEY NOT NULL,
    "endpoint_id" bigint NOT NULL,
    "checked_at" timestamp with time zone DEFAULT now() NOT NULL,
    "outcome" text NOT NULL,
    "http_status" integer,
    "latency_ms" integer NOT NULL,
    "failure_code" text,
    CONSTRAINT "health_check_results_outcome_check"
        CHECK ("outcome" IN ('healthy', 'unhealthy')),
    CONSTRAINT "health_check_results_latency_check"
        CHECK ("latency_ms" >= 0),
    CONSTRAINT "health_check_results_http_status_check"
        CHECK ("http_status" IS NULL OR "http_status" BETWEEN 100 AND 599)
);
--> statement-breakpoint

ALTER TABLE "health_check_results"
    ADD CONSTRAINT "health_check_results_endpoint_id_monitored_endpoints_id_fk"
    FOREIGN KEY ("endpoint_id")
    REFERENCES "public"."monitored_endpoints"("id")
    ON DELETE no action ON UPDATE no action;
--> statement-breakpoint

CREATE INDEX "health_check_results_endpoint_checked_idx"
    ON "health_check_results" USING btree ("endpoint_id", "checked_at");
--> statement-breakpoint

CREATE UNIQUE INDEX "monitored_endpoints_url_uq"
    ON "monitored_endpoints" USING btree ("url");
--> statement-breakpoint

CREATE INDEX "monitored_endpoints_enabled_idx"
    ON "monitored_endpoints" USING btree ("enabled");