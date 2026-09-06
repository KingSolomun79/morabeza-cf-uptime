PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_notification_events` (
	`id` text PRIMARY KEY NOT NULL,
	`dedupe_key` text NOT NULL,
	`monitor_id` text,
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
INSERT INTO `__new_notification_events`("id", "dedupe_key", "monitor_id", "incident_id", "target_id", "type", "status", "attempts", "provider_message_id", "last_error", "created_at", "sent_at", "updated_at") SELECT "id", "dedupe_key", "monitor_id", "incident_id", "target_id", "type", "status", "attempts", "provider_message_id", "last_error", "created_at", "sent_at", "updated_at" FROM `notification_events`;--> statement-breakpoint
DROP TABLE `notification_events`;--> statement-breakpoint
ALTER TABLE `__new_notification_events` RENAME TO `notification_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `notification_events_dedupe_key_idx` ON `notification_events` (`dedupe_key`);