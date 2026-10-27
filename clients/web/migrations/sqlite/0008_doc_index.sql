CREATE TABLE `doc_index` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connection_id` integer NOT NULL,
	`path` text NOT NULL,
	`doc_id` text,
	`kind` text NOT NULL,
	`blob` text NOT NULL,
	`indexed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `doc_index_connection_path_idx` ON `doc_index` (`connection_id`,`path`);--> statement-breakpoint
CREATE INDEX `doc_index_doc_id_idx` ON `doc_index` (`doc_id`);