CREATE TABLE `deletion` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connection_id` integer NOT NULL,
	`path` text NOT NULL,
	`doc_id` text,
	`kind` text NOT NULL,
	`blob` text NOT NULL,
	`deleting_commit` text NOT NULL,
	`deleted_by` text NOT NULL,
	`deleted_at` integer NOT NULL,
	`restored_at` integer
);
--> statement-breakpoint
CREATE INDEX `deletion_connection_idx` ON `deletion` (`connection_id`,`deleted_at`);