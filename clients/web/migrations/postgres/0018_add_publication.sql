CREATE TABLE "fjord"."publication" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "fjord"."publication_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"connection_id" bigint NOT NULL,
	"doc_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "publication_connection_doc_idx" ON "fjord"."publication" USING btree ("connection_id","doc_id");--> statement-breakpoint
CREATE UNIQUE INDEX "publication_token_idx" ON "fjord"."publication" USING btree ("token_hash");