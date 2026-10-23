CREATE TABLE `credential` (
	`id` text PRIMARY KEY NOT NULL,
	`purpose` text NOT NULL,
	`kek_id` text NOT NULL,
	`wrapped_key` text NOT NULL,
	`ciphertext` text NOT NULL,
	`created_at` integer NOT NULL,
	`rewrapped_at` integer
);
--> statement-breakpoint
CREATE INDEX `credential_kek_id_idx` ON `credential` (`kek_id`);