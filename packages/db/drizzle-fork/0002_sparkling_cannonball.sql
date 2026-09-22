CREATE TABLE `branch_promotions` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`host_id` text NOT NULL,
	`path` text NOT NULL,
	`phase` text NOT NULL,
	`intent` text NOT NULL,
	`snapshot` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`settled_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `branch_promotions_active_thread_idx` ON `branch_promotions` (`thread_id`) WHERE "branch_promotions"."settled_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `branch_promotions_active_environment_idx` ON `branch_promotions` (`environment_id`) WHERE "branch_promotions"."settled_at" is null;--> statement-breakpoint
CREATE INDEX `branch_promotions_thread_created_idx` ON `branch_promotions` (`thread_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `threads` ADD `promotion_target` text DEFAULT 'worktree' NOT NULL;
