CREATE TABLE `local_blob` (
	`repository_id` integer NOT NULL,
	`id` text NOT NULL,
	`size` integer NOT NULL,
	`content` text NOT NULL,
	`retired_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_blob_repository_id_idx` ON `local_blob` (`repository_id`,`id`);--> statement-breakpoint
CREATE INDEX `local_blob_retired_idx` ON `local_blob` (`repository_id`,`retired_at`);--> statement-breakpoint
CREATE TABLE `local_branch` (
	`repository_id` integer NOT NULL,
	`name` text NOT NULL,
	`commit_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_branch_repository_name_idx` ON `local_branch` (`repository_id`,`name`);--> statement-breakpoint
CREATE TABLE `local_commit` (
	`repository_id` integer NOT NULL,
	`id` text NOT NULL,
	`parent_id` text,
	`message` text NOT NULL,
	`author_name` text,
	`author_email` text,
	`tree` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_commit_repository_id_idx` ON `local_commit` (`repository_id`,`id`);--> statement-breakpoint
CREATE TABLE `local_repository` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`default_branch` text NOT NULL,
	`file_count` integer NOT NULL,
	`live_bytes` integer NOT NULL,
	`retired_bytes` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_repository_account_name_idx` ON `local_repository` (`account_id`,`name`);