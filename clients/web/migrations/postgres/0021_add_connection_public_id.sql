ALTER TABLE "fjord"."connection" ADD COLUMN "public_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "connection_public_id_idx" ON "fjord"."connection" USING btree ("public_id");