CREATE TABLE "fjord"."local_blob" (
	"repository_id" bigint NOT NULL,
	"id" text NOT NULL,
	"size" bigint NOT NULL,
	"content" text NOT NULL,
	"retired_at" bigint
);
--> statement-breakpoint
CREATE TABLE "fjord"."local_branch" (
	"repository_id" bigint NOT NULL,
	"name" text NOT NULL,
	"commit_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fjord"."local_commit" (
	"repository_id" bigint NOT NULL,
	"id" text NOT NULL,
	"parent_id" text,
	"message" text NOT NULL,
	"author_name" text,
	"author_email" text,
	"tree" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fjord"."local_repository" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "fjord"."local_repository_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"account_id" text NOT NULL,
	"name" text NOT NULL,
	"default_branch" text NOT NULL,
	"file_count" integer NOT NULL,
	"live_bytes" bigint NOT NULL,
	"retired_bytes" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "local_blob_repository_id_idx" ON "fjord"."local_blob" USING btree ("repository_id","id");--> statement-breakpoint
CREATE INDEX "local_blob_retired_idx" ON "fjord"."local_blob" USING btree ("repository_id","retired_at");--> statement-breakpoint
CREATE UNIQUE INDEX "local_branch_repository_name_idx" ON "fjord"."local_branch" USING btree ("repository_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "local_commit_repository_id_idx" ON "fjord"."local_commit" USING btree ("repository_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "local_repository_account_name_idx" ON "fjord"."local_repository" USING btree ("account_id","name");