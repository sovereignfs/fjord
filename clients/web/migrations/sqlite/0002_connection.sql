CREATE TABLE `connection` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` text NOT NULL,
	`provider` text NOT NULL,
	`kind` text NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`branch` text NOT NULL,
	`credential_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connection_account_repository_idx` ON `connection` (`account_id`,`provider`,`owner`,`name`);