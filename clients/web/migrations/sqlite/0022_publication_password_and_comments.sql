ALTER TABLE `publication` ADD `password_hash` text;--> statement-breakpoint
ALTER TABLE `publication` ADD `failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `publication` ADD `locked_until` integer;--> statement-breakpoint
ALTER TABLE `publication` ADD `comments` text DEFAULT 'off' NOT NULL;