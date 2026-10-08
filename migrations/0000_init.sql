CREATE TABLE `movies` (
	`tmdb_id` integer PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`original_title` text,
	`release_date` text,
	`poster_path` text,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_movies` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`tmdb_id` integer NOT NULL,
	`status` text NOT NULL,
	`preferred_medium` text,
	`discovery_type` text,
	`discovery_date` text,
	`discovery_place` text,
	`discovery_note` text,
	`watched_at` text,
	`watched_medium` text,
	`watched_place` text,
	`rating` integer,
	`review` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tmdb_id`) REFERENCES `movies`(`tmdb_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "user_movies_status_check" CHECK("user_movies"."status" IN ('INTERESTED', 'WANT_TO_WATCH', 'WATCHED', 'SKIPPED')),
	CONSTRAINT "user_movies_preferred_medium_check" CHECK("user_movies"."preferred_medium" IS NULL OR "user_movies"."preferred_medium" IN ('THEATER', 'STREAMING', 'RENTAL', 'ANY', 'NONE')),
	CONSTRAINT "user_movies_discovery_type_check" CHECK("user_movies"."discovery_type" IS NULL OR "user_movies"."discovery_type" IN ('THEATER_TRAILER', 'TV_CM', 'WEB_CM', 'SNS', 'ARTICLE', 'FRIEND', 'OTHER')),
	CONSTRAINT "user_movies_watched_medium_check" CHECK("user_movies"."watched_medium" IS NULL OR "user_movies"."watched_medium" IN ('THEATER', 'STREAMING', 'RENTAL', 'OTHER')),
	CONSTRAINT "user_movies_rating_check" CHECK("user_movies"."rating" IS NULL OR ("user_movies"."rating" BETWEEN 1 AND 5))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_movies_user_tmdb_unique` ON `user_movies` (`user_id`,`tmdb_id`);--> statement-breakpoint
CREATE INDEX `user_movies_user_status_medium_idx` ON `user_movies` (`user_id`,`status`,`preferred_medium`);--> statement-breakpoint
CREATE INDEX `user_movies_user_watched_at_idx` ON `user_movies` (`user_id`,`watched_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`google_sub` text NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_google_sub_unique` ON `users` (`google_sub`);