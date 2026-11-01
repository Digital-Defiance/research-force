CREATE TABLE `edit_proposal_events` (
	`id` text PRIMARY KEY NOT NULL,
	`proposal_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`actor_id` text,
	`at` text NOT NULL,
	`at_rev` integer,
	`note` text,
	CONSTRAINT "edit_proposal_events_kind_values" CHECK("edit_proposal_events"."kind" IN ('submitted', 'rebased', 'accepted', 'declined', 'withdrawn')),
	CONSTRAINT "edit_proposal_events_seq" CHECK("edit_proposal_events"."seq" >= 1),
	CONSTRAINT "edit_proposal_events_note" CHECK("edit_proposal_events"."note" IS NULL OR "edit_proposal_events"."kind" = 'declined')
);
--> statement-breakpoint
CREATE INDEX `edit_proposal_events_proposal` ON `edit_proposal_events` (`proposal_id`,`seq`);--> statement-breakpoint
CREATE TABLE `edit_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`target_id` text NOT NULL,
	`target_root_id` text NOT NULL,
	`proposer_id` text NOT NULL,
	`base_rev` integer NOT NULL,
	`applies_to_rev` integer NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`diff` text NOT NULL,
	`explanation` text NOT NULL,
	`reference_ids` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`accepted_by` text,
	`accepted_at` text,
	`closed_by` text,
	`closed_at` text,
	`rev` integer DEFAULT 1 NOT NULL,
	`updated_seq` integer NOT NULL,
	`actor_id` text,
	CONSTRAINT "edit_proposals_state_values" CHECK("edit_proposals"."state" IN ('open', 'accepted', 'declined', 'withdrawn')),
	CONSTRAINT "edit_proposals_base_rev" CHECK("edit_proposals"."base_rev" >= 1),
	CONSTRAINT "edit_proposals_applies_rev" CHECK("edit_proposals"."applies_to_rev" >= "edit_proposals"."base_rev"),
	CONSTRAINT "edit_proposals_accepted_pair" CHECK(("edit_proposals"."state" = 'accepted') = ("edit_proposals"."accepted_by" IS NOT NULL) AND ("edit_proposals"."accepted_by" IS NULL) = ("edit_proposals"."accepted_at" IS NULL)),
	CONSTRAINT "edit_proposals_closed_pair" CHECK(("edit_proposals"."closed_by" IS NULL) = ("edit_proposals"."closed_at" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `edit_proposals_target` ON `edit_proposals` (`target_id`,`state`);--> statement-breakpoint
CREATE INDEX `edit_proposals_proposer` ON `edit_proposals` (`proposer_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `edit_proposals_root` ON `edit_proposals` (`target_root_id`);--> statement-breakpoint
CREATE TABLE `_g_proposal_state` (
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
	CONSTRAINT "events_type_values" CHECK("__new_notification_events"."event_type" IN ('new_submission', 'item_update', 'reply', 'mention', 'review_requested', 'review_completed', 'outside_submission', 'reminder', 'system_alert', 'dissent', 'work_assigned', 'work_update', 'proposal')),
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
	CONSTRAINT "notification_prefs_event_values" CHECK("__new_notification_prefs"."event_type" IN ('new_submission', 'item_update', 'reply', 'mention', 'review_requested', 'review_completed', 'outside_submission', 'reminder', 'system_alert', 'dissent', 'work_assigned', 'work_update', 'proposal')),
	CONSTRAINT "notification_prefs_email_values" CHECK("__new_notification_prefs"."email" IN ('immediate', 'daily_digest', 'off'))
);
--> statement-breakpoint
INSERT INTO `__new_notification_prefs`("member_id", "event_type", "in_app", "email") SELECT "member_id", "event_type", "in_app", "email" FROM `notification_prefs`;--> statement-breakpoint
DROP TABLE `notification_prefs`;--> statement-breakpoint
ALTER TABLE `__new_notification_prefs` RENAME TO `notification_prefs`;