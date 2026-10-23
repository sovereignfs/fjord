CREATE TABLE "fjord"."connection" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "fjord"."connection_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"account_id" text NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"branch" text NOT NULL,
	"credential_id" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "connection_account_repository_idx" ON "fjord"."connection" USING btree ("account_id","provider","owner","name");