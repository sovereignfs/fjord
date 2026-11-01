CREATE TABLE "fjord"."sealed_share" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "fjord"."sealed_share_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"connection_id" bigint NOT NULL,
	"path" text NOT NULL,
	"token_hash" text NOT NULL,
	"mode" text NOT NULL,
	"ciphertext" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sealed_share_token_hash_idx" ON "fjord"."sealed_share" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sealed_share_file_idx" ON "fjord"."sealed_share" USING btree ("connection_id","path");