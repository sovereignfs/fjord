CREATE TABLE `file_handle` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connection_id` integer NOT NULL,
	`path` text NOT NULL,
	`handle` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_handle_connection_path_idx` ON `file_handle` (`connection_id`,`path`);--> statement-breakpoint
CREATE UNIQUE INDEX `file_handle_handle_idx` ON `file_handle` (`handle`);