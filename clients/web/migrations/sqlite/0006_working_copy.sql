CREATE TABLE `working_copy` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connection_id` integer NOT NULL,
	`path` text NOT NULL,
	`base_blob` text NOT NULL,
	`content` text NOT NULL,
	`editors` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_edit` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `working_copy_connection_path_idx` ON `working_copy` (`connection_id`,`path`);