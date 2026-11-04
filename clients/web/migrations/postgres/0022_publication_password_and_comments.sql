ALTER TABLE "fjord"."publication" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "fjord"."publication" ADD COLUMN "failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "fjord"."publication" ADD COLUMN "locked_until" bigint;--> statement-breakpoint
ALTER TABLE "fjord"."publication" ADD COLUMN "comments" text DEFAULT 'off' NOT NULL;