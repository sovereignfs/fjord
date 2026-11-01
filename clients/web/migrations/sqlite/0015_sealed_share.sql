CREATE TABLE `sealed_share` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connection_id` integer NOT NULL,
	`path` text NOT NULL,
	`token_hash` text NOT NULL,
	`mode` text NOT NULL,
	`ciphertext` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sealed_share_token_hash_idx` ON `sealed_share` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sealed_share_file_idx` ON `sealed_share` (`connection_id`,`path`);