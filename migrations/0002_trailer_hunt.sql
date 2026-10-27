CREATE TABLE `trailer_finds` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`visit_tmdb_id` integer NOT NULL,
	`candidate_tmdb_id` integer NOT NULL,
	`result` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "trailer_finds_result_check" CHECK("trailer_finds"."result" IN ('match', 'reject'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trailer_finds_user_visit_candidate_unique` ON `trailer_finds` (`user_id`,`visit_tmdb_id`,`candidate_tmdb_id`);--> statement-breakpoint
ALTER TABLE `user_movies` ADD `trailer_count` integer CHECK (`trailer_count` IS NULL OR `trailer_count` BETWEEN 0 AND 20);--> statement-breakpoint
ALTER TABLE `user_movies` ADD `trailer_hunt_closed_at` text;