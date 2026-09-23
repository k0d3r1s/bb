CREATE TABLE `fork_spend_prices` (
	`provider_id` text NOT NULL,
	`model` text NOT NULL,
	`input_usd_per_mtok` real NOT NULL,
	`cached_input_usd_per_mtok` real NOT NULL,
	`output_usd_per_mtok` real NOT NULL,
	PRIMARY KEY(`provider_id`, `model`)
);
--> statement-breakpoint
CREATE TABLE `fork_thread_execution_reports` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`model` text NOT NULL,
	`reasoning_level` text,
	`permission_mode` text,
	`service_tier` text,
	`reported_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `fork_thread_spend_cursor` (
	`thread_id` text NOT NULL,
	`provider_thread_id` text NOT NULL,
	`last_sequence` integer NOT NULL,
	`last_total_tokens` integer NOT NULL,
	`first_sequence` integer NOT NULL,
	`history_complete` integer DEFAULT 0 NOT NULL,
	`last_turn_id` text,
	`last_model` text,
	PRIMARY KEY(`thread_id`, `provider_thread_id`)
);
--> statement-breakpoint
CREATE TABLE `fork_thread_spend_daily` (
	`day` text NOT NULL,
	`thread_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`cached_input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`reasoning_output_tokens` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`weighted_units` real DEFAULT 0 NOT NULL,
	`turns` integer DEFAULT 0 NOT NULL,
	`first_event_at` integer NOT NULL,
	`last_event_at` integer NOT NULL,
	PRIMARY KEY(`day`, `thread_id`, `provider_id`, `model`)
);
--> statement-breakpoint
CREATE INDEX `fork_thread_spend_daily_day_idx` ON `fork_thread_spend_daily` (`day`);