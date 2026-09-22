CREATE TABLE `work_admissions` (
	`id` text PRIMARY KEY NOT NULL,
	`command_type` text NOT NULL,
	`transport` text NOT NULL,
	`host_id` text,
	`context_json` text DEFAULT '{}' NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`settled_at` integer,
	CONSTRAINT "work_admissions_transport_valid" CHECK("work_admissions"."transport" in ('settled', 'onlineRpc')),
	CONSTRAINT "work_admissions_state_valid" CHECK("work_admissions"."state" in ('pending', 'active', 'settled'))
);
--> statement-breakpoint
CREATE INDEX `work_admissions_state_idx` ON `work_admissions` (`state`);--> statement-breakpoint
CREATE INDEX `work_admissions_host_id_idx` ON `work_admissions` (`host_id`);--> statement-breakpoint
CREATE TABLE `work_quiesce` (
	`scope` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`owner_secret_hash` text NOT NULL,
	`reason` text NOT NULL,
	`phase` text NOT NULL,
	`acquired_at` integer NOT NULL,
	`expires_at` integer,
	`candidate_release` text,
	`previous_release` text,
	`cohort_json` text DEFAULT '[]' NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "work_quiesce_global_scope" CHECK("work_quiesce"."scope" = 'global'),
	CONSTRAINT "work_quiesce_operation_id_nonempty" CHECK(length("work_quiesce"."operation_id") > 0),
	CONSTRAINT "work_quiesce_owner_secret_hash_nonempty" CHECK(length("work_quiesce"."owner_secret_hash") > 0),
	CONSTRAINT "work_quiesce_reason_nonempty" CHECK(length("work_quiesce"."reason") > 0),
	CONSTRAINT "work_quiesce_phase_valid" CHECK("work_quiesce"."phase" in ('draining', 'sealing', 'sealed', 'activating', 'verifying', 'rolling-back', 'rollback-failed', 'releasing'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_quiesce_operation_id_unique` ON `work_quiesce` (`operation_id`);--> statement-breakpoint
CREATE TABLE `work_quiesce_resolutions` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`resolution` text NOT NULL,
	`resolved_at` integer NOT NULL
);
