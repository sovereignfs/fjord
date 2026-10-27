CREATE TABLE "fjord"."share_link" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "fjord"."share_link_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"connection_id" bigint NOT NULL,
	"doc_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"role" text NOT NULL,
	"expires_at" bigint,
	"revoked_at" bigint,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "share_link_token_hash_idx" ON "fjord"."share_link" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "share_link_document_idx" ON "fjord"."share_link" USING btree ("connection_id","doc_id");