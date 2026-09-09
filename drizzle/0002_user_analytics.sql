ALTER TABLE `users` ADD `last_login_at` text;--> statement-breakpoint
ALTER TABLE `users` ADD `login_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_users_created_id` ON `users` (`created_at`,`id`);