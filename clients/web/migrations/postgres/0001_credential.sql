CREATE TABLE "fjord"."credential" (
	"id" text PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"kek_id" text NOT NULL,
	"wrapped_key" text NOT NULL,
	"ciphertext" text NOT NULL,
	"created_at" bigint NOT NULL,
	"rewrapped_at" bigint
);
--> statement-breakpoint
CREATE INDEX "credential_kek_id_idx" ON "fjord"."credential" USING btree ("kek_id");