CREATE TABLE `journal_entry` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connection_id` integer NOT NULL,
	`path` text NOT NULL,
	`blob` text NOT NULL,
	`summary` text NOT NULL,
	`indexed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `journal_entry_connection_blob_path_idx` ON `journal_entry` (`connection_id`,`blob`,`path`);