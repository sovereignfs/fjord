CREATE TABLE "fjord"."deletion" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "fjord"."deletion_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"connection_id" bigint NOT NULL,
	"path" text NOT NULL,
	"doc_id" text,
	"kind" text NOT NULL,
	"blob" text NOT NULL,
	"deleting_commit" text NOT NULL,
	"deleted_by" text NOT NULL,
	"deleted_at" bigint NOT NULL,
	"restored_at" bigint
);
--> statement-breakpoint
CREATE INDEX "deletion_connection_idx" ON "fjord"."deletion" USING btree ("connection_id","deleted_at");