CREATE TABLE `alerts` (
	`upstream_id` integer PRIMARY KEY NOT NULL,
	`state` text DEFAULT 'normal' NOT NULL,
	`last_sent_at` integer,
	`last_result` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`upstream_id`) REFERENCES `upstreams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `balance_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`upstream_id` integer NOT NULL,
	`ts` integer NOT NULL,
	`balance_usd` real,
	`mode` text NOT NULL,
	`ok` integer NOT NULL,
	`error` text,
	`raw` text,
	FOREIGN KEY (`upstream_id`) REFERENCES `upstreams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `balance_snapshots_upstream_ts_idx` ON `balance_snapshots` (`upstream_id`,`ts`);--> statement-breakpoint
CREATE TABLE `upstreams` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`site_url` text NOT NULL,
	`match_domains` text DEFAULT '[]' NOT NULL,
	`topup_url` text,
	`threshold` real NOT NULL,
	`emergency_threshold` real,
	`interval_minutes` integer DEFAULT 10 NOT NULL,
	`rate_factor` real DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`credential_enc` text NOT NULL,
	`user_id_enc` text,
	`account_enc` text,
	`password_enc` text,
	`last_checked_at` integer,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
