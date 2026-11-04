ALTER TABLE `connection` ADD `public_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `connection_public_id_idx` ON `connection` (`public_id`);