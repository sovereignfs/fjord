CREATE TABLE `share_link` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connection_id` integer NOT NULL,
	`doc_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`role` text NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `share_link_token_hash_idx` ON `share_link` (`token_hash`);--> statement-breakpoint
CREATE INDEX `share_link_document_idx` ON `share_link` (`connection_id`,`doc_id`);