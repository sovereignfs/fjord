CREATE TABLE "fjord"."journal_entry" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "fjord"."journal_entry_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"connection_id" bigint NOT NULL,
	"path" text NOT NULL,
	"blob" text NOT NULL,
	"summary" text NOT NULL,
	"indexed_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entry_connection_blob_path_idx" ON "fjord"."journal_entry" USING btree ("connection_id","blob","path");