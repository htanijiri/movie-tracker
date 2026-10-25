CREATE TABLE `movie_providers` (
	`tmdb_id` integer PRIMARY KEY NOT NULL,
	`providers` text NOT NULL,
	`checked_at` text NOT NULL,
	FOREIGN KEY (`tmdb_id`) REFERENCES `movies`(`tmdb_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `streaming_notices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`tmdb_id` integer NOT NULL,
	`provider_id` integer NOT NULL,
	`provider_name` text NOT NULL,
	`detected_at` text NOT NULL,
	`dismissed_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tmdb_id`) REFERENCES `movies`(`tmdb_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `streaming_notices_user_movie_provider_unique` ON `streaming_notices` (`user_id`,`tmdb_id`,`provider_id`);--> statement-breakpoint
CREATE INDEX `streaming_notices_user_dismissed_idx` ON `streaming_notices` (`user_id`,`dismissed_at`);--> statement-breakpoint
ALTER TABLE `movies` ADD `genre_ids` text;