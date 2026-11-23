CREATE TABLE `trailer_chats` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`visit_tmdb_id` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`candidates` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "trailer_chats_role_check" CHECK("trailer_chats"."role" IN ('user', 'assistant'))
);
--> statement-breakpoint
CREATE INDEX `trailer_chats_user_visit_idx` ON `trailer_chats` (`user_id`,`visit_tmdb_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `trailer_chats_user_created_idx` ON `trailer_chats` (`user_id`,`created_at`);