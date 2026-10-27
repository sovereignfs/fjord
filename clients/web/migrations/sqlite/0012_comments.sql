CREATE TABLE `comment_activity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connection_id` integer NOT NULL,
	`doc_id` text NOT NULL,
	`thread_id` integer,
	`actor_kind` text NOT NULL,
	`actor_name` text NOT NULL,
	`event` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `comment_activity_document_idx` ON `comment_activity` (`connection_id`,`doc_id`,`at`);--> statement-breakpoint
CREATE TABLE `comment_closed` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connection_id` integer NOT NULL,
	`doc_id` text NOT NULL,
	`closed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `comment_closed_document_idx` ON `comment_closed` (`connection_id`,`doc_id`);--> statement-breakpoint
CREATE TABLE `comment_reply` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`thread_id` integer NOT NULL,
	`connection_id` integer NOT NULL,
	`doc_id` text NOT NULL,
	`body` text NOT NULL,
	`author_kind` text NOT NULL,
	`author_id` text NOT NULL,
	`author_name` text NOT NULL,
	`created_at` integer NOT NULL,
	`edited_at` integer
);
--> statement-breakpoint
CREATE INDEX `comment_reply_thread_idx` ON `comment_reply` (`thread_id`);--> statement-breakpoint
CREATE INDEX `comment_reply_document_idx` ON `comment_reply` (`connection_id`,`doc_id`);--> statement-breakpoint
CREATE TABLE `comment_thread` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connection_id` integer NOT NULL,
	`doc_id` text NOT NULL,
	`anchor` text NOT NULL,
	`body` text NOT NULL,
	`author_kind` text NOT NULL,
	`author_id` text NOT NULL,
	`author_name` text NOT NULL,
	`created_at` integer NOT NULL,
	`edited_at` integer,
	`resolved_at` integer,
	`resolved_by` text
);
--> statement-breakpoint
CREATE INDEX `comment_thread_document_idx` ON `comment_thread` (`connection_id`,`doc_id`);