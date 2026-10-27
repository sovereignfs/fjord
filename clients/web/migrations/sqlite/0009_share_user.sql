CREATE TABLE `share_user` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connection_id` integer NOT NULL,
	`doc_id` text NOT NULL,
	`account_id` text NOT NULL,
	`role` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `share_user_document_account_idx` ON `share_user` (`connection_id`,`doc_id`,`account_id`);--> statement-breakpoint
CREATE INDEX `share_user_account_idx` ON `share_user` (`account_id`);