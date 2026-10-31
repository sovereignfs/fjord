CREATE TABLE "fjord"."rate_bucket" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "fjord"."rate_bucket_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"key" text NOT NULL,
	"window_start" bigint NOT NULL,
	"count" integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "rate_bucket_key_idx" ON "fjord"."rate_bucket" USING btree ("key");--> statement-breakpoint
CREATE INDEX "rate_bucket_window_idx" ON "fjord"."rate_bucket" USING btree ("window_start");