CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`action` text NOT NULL,
	`target` text,
	`ip` text,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `audit_log_ts_idx` ON `audit_log` (`ts`);--> statement-breakpoint
CREATE TABLE `auth` (
	`id` integer PRIMARY KEY NOT NULL,
	`password_hash` text NOT NULL,
	`session_version` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `login_attempts` (
	`ip` text PRIMARY KEY NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`last_failure_at` integer DEFAULT 0 NOT NULL,
	`locked_until` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `login_codes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used` integer DEFAULT false NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `login_codes_created_idx` ON `login_codes` (`created_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`encrypted` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL
);
