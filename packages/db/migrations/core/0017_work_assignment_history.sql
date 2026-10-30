CREATE TABLE `_g_work_cycle` (
	`x` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `_g_work_state` (
	`x` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `work_events` (
	`id` text PRIMARY KEY NOT NULL,
	`work_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`at` text NOT NULL,
	`subject_id` text,
	`detail` text,
	CONSTRAINT "work_events_kind_values" CHECK("work_events"."kind" IN ('assigned', 'unassigned', 'accepted', 'declined', 'responsible', 'due_date', 'state', 'dependency_added', 'dependency_removed', 'dependency_kind'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_events_seq` ON `work_events` (`work_id`,`seq`);--> statement-breakpoint
CREATE INDEX `work_events_subject` ON `work_events` (`subject_id`);--> statement-breakpoint
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
	CONSTRAINT "events_type_values" CHECK("__new_notification_events"."event_type" IN ('new_submission', 'item_update', 'reply', 'mention', 'review_requested', 'review_completed', 'outside_submission', 'reminder', 'system_alert', 'dissent', 'work_assigned', 'work_update')),
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
	CONSTRAINT "notification_prefs_event_values" CHECK("__new_notification_prefs"."event_type" IN ('new_submission', 'item_update', 'reply', 'mention', 'review_requested', 'review_completed', 'outside_submission', 'reminder', 'system_alert', 'dissent', 'work_assigned', 'work_update')),
	CONSTRAINT "notification_prefs_email_values" CHECK("__new_notification_prefs"."email" IN ('immediate', 'daily_digest', 'off'))
);
--> statement-breakpoint
INSERT INTO `__new_notification_prefs`("member_id", "event_type", "in_app", "email") SELECT "member_id", "event_type", "in_app", "email" FROM `notification_prefs`;--> statement-breakpoint
DROP TABLE `notification_prefs`;--> statement-breakpoint
ALTER TABLE `__new_notification_prefs` RENAME TO `notification_prefs`;--> statement-breakpoint
-- History is added, never changed (R52.6).
CREATE TRIGGER `work_events_immutable` BEFORE UPDATE ON `work_events`
BEGIN SELECT RAISE(ABORT, 'work_event_immutable'); END;
