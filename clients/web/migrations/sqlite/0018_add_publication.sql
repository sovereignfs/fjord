CREATE TABLE `publication` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connection_id` integer NOT NULL,
	`doc_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publication_connection_doc_idx` ON `publication` (`connection_id`,`doc_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `publication_token_idx` ON `publication` (`token_hash`);