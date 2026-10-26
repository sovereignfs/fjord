CREATE TABLE "fjord"."working_copy" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "fjord"."working_copy_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"connection_id" bigint NOT NULL,
	"path" text NOT NULL,
	"base_blob" text NOT NULL,
	"content" text NOT NULL,
	"editors" text NOT NULL,
	"created_at" bigint NOT NULL,
	"last_edit" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "working_copy_connection_path_idx" ON "fjord"."working_copy" USING btree ("connection_id","path");