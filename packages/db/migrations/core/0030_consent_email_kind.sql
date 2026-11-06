PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_outgoing_emails` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`recipient` text NOT NULL,
	`member_id` text,
	`outside_submission_id` text,
	`payload_ref` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`sendable_at` text NOT NULL,
	`held_ms` integer DEFAULT 0 NOT NULL,
	`first_failed_at` text,
	`sent_at` text,
	`failed_at` text,
	`rev` integer DEFAULT 1 NOT NULL,
	`updated_seq` integer NOT NULL,
	`actor_id` text,
	CONSTRAINT "outgoing_emails_kind_values" CHECK("__new_outgoing_emails"."kind" IN ('invitation', 'acknowledgement', 'more_information', 'decision', 'consent')),
	CONSTRAINT "outgoing_emails_state_values" CHECK("__new_outgoing_emails"."state" IN ('queued', 'sent', 'failed'))
);
--> statement-breakpoint
INSERT INTO `__new_outgoing_emails`("id", "kind", "recipient", "member_id", "outside_submission_id", "payload_ref", "state", "attempts", "created_at", "sendable_at", "held_ms", "first_failed_at", "sent_at", "failed_at", "rev", "updated_seq", "actor_id") SELECT "id", "kind", "recipient", "member_id", "outside_submission_id", "payload_ref", "state", "attempts", "created_at", "sendable_at", "held_ms", "first_failed_at", "sent_at", "failed_at", "rev", "updated_seq", "actor_id" FROM `outgoing_emails`;--> statement-breakpoint
DROP TABLE `outgoing_emails`;--> statement-breakpoint
ALTER TABLE `__new_outgoing_emails` RENAME TO `outgoing_emails`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `outgoing_emails_state` ON `outgoing_emails` (`state`,`sendable_at`);--> statement-breakpoint
CREATE INDEX `outgoing_emails_member` ON `outgoing_emails` (`member_id`);--> statement-breakpoint
CREATE INDEX `outgoing_emails_outside` ON `outgoing_emails` (`outside_submission_id`);