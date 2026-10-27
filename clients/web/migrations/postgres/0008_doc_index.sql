CREATE TABLE "fjord"."doc_index" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "fjord"."doc_index_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"connection_id" bigint NOT NULL,
	"path" text NOT NULL,
	"doc_id" text,
	"kind" text NOT NULL,
	"blob" text NOT NULL,
	"indexed_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "doc_index_connection_path_idx" ON "fjord"."doc_index" USING btree ("connection_id","path");--> statement-breakpoint
CREATE INDEX "doc_index_doc_id_idx" ON "fjord"."doc_index" USING btree ("doc_id");