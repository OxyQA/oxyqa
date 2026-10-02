ALTER TABLE "plans" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "tracking_issue_number" integer;--> statement-breakpoint
ALTER TABLE "test_cases" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;