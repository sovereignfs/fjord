CREATE TABLE `rate_bucket` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rate_bucket_key_idx` ON `rate_bucket` (`key`);--> statement-breakpoint
CREATE INDEX `rate_bucket_window_idx` ON `rate_bucket` (`window_start`);