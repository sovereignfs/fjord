CREATE TABLE `tree_cache` (
	`connection_id` integer NOT NULL,
	`commit_id` text NOT NULL,
	`listing` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tree_cache_connection_commit_idx` ON `tree_cache` (`connection_id`,`commit_id`);