CREATE TABLE `channels` (
	`site_id` integer DEFAULT 1 NOT NULL,
	`channel_id` integer NOT NULL,
	`name` text NOT NULL,
	`type` integer DEFAULT 0 NOT NULL,
	`base_url` text DEFAULT '' NOT NULL,
	`groups` text DEFAULT '[]' NOT NULL,
	`status` integer NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`weight` integer DEFAULT 0 NOT NULL,
	`response_time` integer DEFAULT 0 NOT NULL,
	`tag` text DEFAULT '' NOT NULL,
	`upstream_id` integer,
	`manual_upstream` integer DEFAULT false NOT NULL,
	`auto_disabled_at` integer,
	`synced_at` integer NOT NULL,
	PRIMARY KEY(`site_id`, `channel_id`),
	FOREIGN KEY (`upstream_id`) REFERENCES `upstreams`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `channels_upstream_idx` ON `channels` (`upstream_id`);