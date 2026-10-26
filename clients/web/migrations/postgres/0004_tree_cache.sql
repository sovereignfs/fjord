CREATE TABLE "fjord"."tree_cache" (
	"connection_id" bigint NOT NULL,
	"commit_id" text NOT NULL,
	"listing" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tree_cache_connection_commit_idx" ON "fjord"."tree_cache" USING btree ("connection_id","commit_id");