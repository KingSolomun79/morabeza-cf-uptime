CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_email` text,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text,
	`summary` text,
	`metadata_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `check_results` (
	`id` text PRIMARY KEY NOT NULL,
	`monitor_id` text NOT NULL,
	`source` text NOT NULL,
	`scheduled_for` text,
	`started_at` text NOT NULL,
	`completed_at` text NOT NULL,
	`is_healthy` integer NOT NULL,
	`maintenance_excluded` integer DEFAULT 0 NOT NULL,
	`affects_state` integer DEFAULT 0 NOT NULL,
	`status_code` integer,
	`response_time_ms` integer,
	`final_url` text,
	`reason_code` text NOT NULL,
	`error_message` text,
	`assertions_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `check_results_monitor_completed_idx` ON `check_results` (`monitor_id`,"completed_at" desc);--> statement-breakpoint
CREATE INDEX `check_results_completed_idx` ON `check_results` (`completed_at`);--> statement-breakpoint
CREATE INDEX `check_results_source_completed_idx` ON `check_results` (`source`,`completed_at`);--> statement-breakpoint
CREATE TABLE `clients` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clients_slug_idx` ON `clients` (`slug`);--> statement-breakpoint
CREATE INDEX `clients_active_idx` ON `clients` (`active`);--> statement-breakpoint
CREATE TABLE `daily_rollups` (
	`monitor_id` text NOT NULL,
	`day_start` text NOT NULL,
	`eligible_checks` integer NOT NULL,
	`up_checks` integer NOT NULL,
	`down_checks` integer NOT NULL,
	`avg_response_time_ms` real,
	`min_response_time_ms` integer,
	`max_response_time_ms` integer,
	`incident_count` integer DEFAULT 0 NOT NULL,
	`downtime_ms` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`monitor_id`, `day_start`)
);
--> statement-breakpoint
CREATE TABLE `dead_letter_events` (
	`id` text PRIMARY KEY NOT NULL,
	`original_job_id` text,
	`message_type` text,
	`payload_summary_json` text,
	`failure_reason` text,
	`received_at` text NOT NULL,
	`resolved_at` text,
	`resolution_notes` text
);
--> statement-breakpoint
CREATE TABLE `hourly_rollups` (
	`monitor_id` text NOT NULL,
	`hour_start` text NOT NULL,
	`eligible_checks` integer NOT NULL,
	`up_checks` integer NOT NULL,
	`down_checks` integer NOT NULL,
	`avg_response_time_ms` real,
	`min_response_time_ms` integer,
	`max_response_time_ms` integer,
	PRIMARY KEY(`monitor_id`, `hour_start`)
);
--> statement-breakpoint
CREATE TABLE `incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`monitor_id` text NOT NULL,
	`status` text NOT NULL,
	`opened_at` text NOT NULL,
	`first_failure_at` text NOT NULL,
	`resolved_at` text,
	`trigger_check_id` text,
	`recovery_check_id` text,
	`open_reason_code` text,
	`outage_duration_ms` integer,
	`resolution_reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `incidents_monitor_status_idx` ON `incidents` (`monitor_id`,`status`);--> statement-breakpoint
CREATE TABLE `maintenance_windows` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`scope_type` text NOT NULL,
	`scope_id` text,
	`starts_at` text NOT NULL,
	`ends_at` text NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`cancelled_at` text
);
--> statement-breakpoint
CREATE INDEX `maintenance_windows_scope_idx` ON `maintenance_windows` (`scope_type`,`scope_id`);--> statement-breakpoint
CREATE TABLE `monitor_notification_targets` (
	`monitor_id` text NOT NULL,
	`target_id` text NOT NULL,
	PRIMARY KEY(`monitor_id`, `target_id`),
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_id`) REFERENCES `notification_targets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `monitor_state` (
	`monitor_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`consecutive_successes` integer DEFAULT 0 NOT NULL,
	`failure_sequence_started_at` text,
	`last_evaluated_scheduled_for` text,
	`last_checked_at` text,
	`last_success_at` text,
	`last_failure_at` text,
	`last_status_code` integer,
	`last_response_time_ms` integer,
	`last_reason_code` text,
	`open_incident_id` text,
	`state_version` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`open_incident_id`) REFERENCES `incidents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `monitors` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`method` text DEFAULT 'GET' NOT NULL,
	`headers_json` text,
	`request_body` text,
	`expected_status_codes_json` text DEFAULT '[200]' NOT NULL,
	`body_contains` text,
	`body_not_contains` text,
	`max_response_time_ms` integer,
	`interval_seconds` integer DEFAULT 300 NOT NULL,
	`timeout_ms` integer DEFAULT 10000 NOT NULL,
	`failure_threshold` integer DEFAULT 3 NOT NULL,
	`recovery_threshold` integer DEFAULT 2 NOT NULL,
	`cache_bust` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`next_check_at` text NOT NULL,
	`tags_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`archived_at` text,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `monitors_client_id_idx` ON `monitors` (`client_id`);--> statement-breakpoint
CREATE INDEX `monitors_enabled_next_check_idx` ON `monitors` (`enabled`,`next_check_at`);--> statement-breakpoint
CREATE INDEX `monitors_archived_idx` ON `monitors` (`archived_at`);--> statement-breakpoint
CREATE TABLE `notification_events` (
	`id` text PRIMARY KEY NOT NULL,
	`dedupe_key` text NOT NULL,
	`monitor_id` text NOT NULL,
	`incident_id` text,
	`target_id` text NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`provider_message_id` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`sent_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`incident_id`) REFERENCES `incidents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_id`) REFERENCES `notification_targets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_events_dedupe_key_idx` ON `notification_events` (`dedupe_key`);--> statement-breakpoint
CREATE TABLE `notification_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`is_default` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_targets_email_idx` ON `notification_targets` (`email`);--> statement-breakpoint
CREATE TABLE `scheduler_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`scheduled_at` text NOT NULL,
	`due_monitor_count` integer NOT NULL,
	`enqueued_count` integer NOT NULL,
	`failed_batch_count` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer NOT NULL,
	`error_message` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `system_state` (
	`id` text PRIMARY KEY NOT NULL,
	`last_scheduler_at` text,
	`last_queue_consumer_at` text,
	`last_hourly_rollup_at` text,
	`last_daily_rollup_at` text,
	`last_cleanup_at` text,
	`updated_at` text NOT NULL
);
