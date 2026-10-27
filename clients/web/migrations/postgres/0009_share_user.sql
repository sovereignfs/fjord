CREATE TABLE "fjord"."share_user" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "fjord"."share_user_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"connection_id" bigint NOT NULL,
	"doc_id" text NOT NULL,
	"account_id" text NOT NULL,
	"role" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "share_user_document_account_idx" ON "fjord"."share_user" USING btree ("connection_id","doc_id","account_id");--> statement-breakpoint
CREATE INDEX "share_user_account_idx" ON "fjord"."share_user" USING btree ("account_id");