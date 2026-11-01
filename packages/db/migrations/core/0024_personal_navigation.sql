CREATE TABLE `bookmarks` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`target_id` text NOT NULL,
	`target_root_id` text NOT NULL,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` text NOT NULL,
	`rev` integer DEFAULT 1 NOT NULL,
	`updated_seq` integer NOT NULL,
	`actor_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bookmarks_member_target` ON `bookmarks` (`member_id`,`target_id`);--> statement-breakpoint
CREATE INDEX `bookmarks_member` ON `bookmarks` (`member_id`,`position`);--> statement-breakpoint
CREATE INDEX `bookmarks_target` ON `bookmarks` (`target_id`);--> statement-breakpoint
CREATE TABLE `saved_searches` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`name` text NOT NULL,
	`filters` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` text NOT NULL,
	`rev` integer DEFAULT 1 NOT NULL,
	`updated_seq` integer NOT NULL,
	`actor_id` text
);
--> statement-breakpoint
CREATE INDEX `saved_searches_member` ON `saved_searches` (`member_id`,`position`);--> statement-breakpoint
CREATE TABLE `follows` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`kind` text NOT NULL,
	`target_id` text NOT NULL,
	`target_root_id` text NOT NULL,
	`in_app` integer DEFAULT true NOT NULL,
	`email` text DEFAULT 'immediate' NOT NULL,
	`created_at` text NOT NULL,
	`rev` integer DEFAULT 1 NOT NULL,
	`updated_seq` integer NOT NULL,
	`actor_id` text,
	CONSTRAINT "follows_kind_values" CHECK("follows"."kind" IN ('item', 'question')),
	CONSTRAINT "follows_email_values" CHECK("follows"."email" IN ('immediate', 'daily_digest', 'off'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `follows_member_target` ON `follows` (`member_id`,`target_id`);--> statement-breakpoint
CREATE INDEX `follows_target` ON `follows` (`target_id`);--> statement-breakpoint
CREATE INDEX `follows_member` ON `follows` (`member_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `_g_personal_owner` (
	`x` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `_g_personal_limit` (
	`x` integer NOT NULL
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_notification_events` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`event_type` text NOT NULL,
	`at` text NOT NULL,
	`actor_id` text,
	`root_id` text,
	`submission_id` text,
	`outside_submission_id` text,
	`alert_key` text,
	`detail` text,
	`notification_id` text,
	`email_mode` text NOT NULL,
	`email_batch_id` text,
	`digest_sent_at` text,
	CONSTRAINT "events_type_values" CHECK("__new_notification_events"."event_type" IN ('new_submission', 'item_update', 'reply', 'mention', 'review_requested', 'review_completed', 'outside_submission', 'reminder', 'system_alert', 'dissent', 'work_assigned', 'work_update', 'proposal', 'follow_update')),
	CONSTRAINT "events_email_values" CHECK("__new_notification_events"."email_mode" IN ('immediate', 'daily_digest', 'off'))
);
--> statement-breakpoint
INSERT INTO `__new_notification_events`("id", "member_id", "event_type", "at", "actor_id", "root_id", "submission_id", "outside_submission_id", "alert_key", "detail", "notification_id", "email_mode", "email_batch_id", "digest_sent_at") SELECT "id", "member_id", "event_type", "at", "actor_id", "root_id", "submission_id", "outside_submission_id", "alert_key", "detail", "notification_id", "email_mode", "email_batch_id", "digest_sent_at" FROM `notification_events`;--> statement-breakpoint
DROP TABLE `notification_events`;--> statement-breakpoint
ALTER TABLE `__new_notification_events` RENAME TO `notification_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `events_member` ON `notification_events` (`member_id`,`at`);--> statement-breakpoint
CREATE INDEX `events_digest` ON `notification_events` (`email_mode`,`digest_sent_at`,`member_id`);--> statement-breakpoint
CREATE INDEX `events_batch` ON `notification_events` (`email_batch_id`);--> statement-breakpoint
CREATE INDEX `events_notification` ON `notification_events` (`notification_id`);--> statement-breakpoint
CREATE TABLE `__new_notification_prefs` (
	`member_id` text NOT NULL,
	`event_type` text NOT NULL,
	`in_app` integer DEFAULT true NOT NULL,
	`email` text DEFAULT 'immediate' NOT NULL,
	PRIMARY KEY(`member_id`, `event_type`),
	CONSTRAINT "notification_prefs_event_values" CHECK("__new_notification_prefs"."event_type" IN ('new_submission', 'item_update', 'reply', 'mention', 'review_requested', 'review_completed', 'outside_submission', 'reminder', 'system_alert', 'dissent', 'work_assigned', 'work_update', 'proposal', 'follow_update')),
	CONSTRAINT "notification_prefs_email_values" CHECK("__new_notification_prefs"."email" IN ('immediate', 'daily_digest', 'off'))
);
--> statement-breakpoint
INSERT INTO `__new_notification_prefs`("member_id", "event_type", "in_app", "email") SELECT "member_id", "event_type", "in_app", "email" FROM `notification_prefs`;--> statement-breakpoint
DROP TABLE `notification_prefs`;--> statement-breakpoint
ALTER TABLE `__new_notification_prefs` RENAME TO `notification_prefs`;
