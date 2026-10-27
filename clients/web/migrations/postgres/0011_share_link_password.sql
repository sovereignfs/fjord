ALTER TABLE "fjord"."share_link" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "fjord"."share_link" ADD COLUMN "failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "fjord"."share_link" ADD COLUMN "locked_until" bigint;