CREATE TABLE IF NOT EXISTS "repo_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" bigint NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"content" text NOT NULL,
	"source" text DEFAULT 'command' NOT NULL,
	"created_by" text NOT NULL,
	"source_comment_id" bigint,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "repo_memories" ADD CONSTRAINT "repo_memories_installation_id_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repo_memories_repo_idx" ON "repo_memories" USING btree ("installation_id","owner","repo","active");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "repo_memories_command_uniq" ON "repo_memories" USING btree ("installation_id","source_comment_id");