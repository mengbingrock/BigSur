CREATE TABLE `users` (
	`email` text PRIMARY KEY NOT NULL,
	`password_hash` text NOT NULL,
	`is_admin` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL
);
