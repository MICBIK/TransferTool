CREATE TABLE `channel_stats` (
	`site_id` integer DEFAULT 1 NOT NULL,
	`channel_id` integer NOT NULL,
	`bucket_start` integer NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL,
	`errors` integer DEFAULT 0 NOT NULL,
	`total_use_time` integer DEFAULT 0 NOT NULL,
	`error_samples` text DEFAULT '[]' NOT NULL,
	`last_success_at` integer,
	PRIMARY KEY(`site_id`, `channel_id`, `bucket_start`)
);
--> statement-breakpoint
CREATE INDEX `channel_stats_bucket_idx` ON `channel_stats` (`bucket_start`);