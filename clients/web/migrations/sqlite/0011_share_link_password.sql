ALTER TABLE `share_link` ADD `password_hash` text;--> statement-breakpoint
ALTER TABLE `share_link` ADD `failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `share_link` ADD `locked_until` integer;