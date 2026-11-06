PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_consent_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`party_id` text NOT NULL,
	`requested_by` text NOT NULL,
	`kind` text NOT NULL,
	`contact_email` text NOT NULL,
	`message` text,
	`token_hash` text,
	`change_token_hash` text,
	`preview_digest` text NOT NULL,
	`state` text DEFAULT 'sent' NOT NULL,
	`sent_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`change_expires_at` text,
	`reminded_at` text,
	`answered_at` text,
	`cancelled_at` text,
	`expired_at` text,
	`tokens_deleted_at` text,
	`updated_seq` integer NOT NULL,
	`actor_id` text,
	CONSTRAINT "consent_requests_kind_values" CHECK("__new_consent_requests"."kind" IN ('publication', 'rights')),
	CONSTRAINT "consent_requests_state_values" CHECK("__new_consent_requests"."state" IN ('sent', 'answered', 'cancelled', 'expired')),
	CONSTRAINT "consent_requests_token_hash" CHECK("__new_consent_requests"."token_hash" IS NULL OR length("__new_consent_requests"."token_hash") = 64),
	CONSTRAINT "consent_requests_change_token_hash" CHECK("__new_consent_requests"."change_token_hash" IS NULL OR length("__new_consent_requests"."change_token_hash") = 64),
	CONSTRAINT "consent_requests_preview_digest" CHECK(length("__new_consent_requests"."preview_digest") = 64),
	CONSTRAINT "consent_requests_change_pair" CHECK("__new_consent_requests"."tokens_deleted_at" IS NOT NULL OR (("__new_consent_requests"."change_token_hash" IS NULL) = ("__new_consent_requests"."change_expires_at" IS NULL) AND ("__new_consent_requests"."change_token_hash" IS NULL OR "__new_consent_requests"."answered_at" IS NOT NULL))),
	CONSTRAINT "consent_requests_tokens_deleted" CHECK(("__new_consent_requests"."tokens_deleted_at" IS NULL) = ("__new_consent_requests"."token_hash" IS NOT NULL) AND ("__new_consent_requests"."tokens_deleted_at" IS NULL OR "__new_consent_requests"."change_token_hash" IS NULL)),
	CONSTRAINT "consent_requests_state_stamp" CHECK(("__new_consent_requests"."state" = 'answered') = ("__new_consent_requests"."answered_at" IS NOT NULL) AND ("__new_consent_requests"."state" = 'cancelled') = ("__new_consent_requests"."cancelled_at" IS NOT NULL) AND ("__new_consent_requests"."state" = 'expired') = ("__new_consent_requests"."expired_at" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_consent_requests`("id", "party_id", "requested_by", "kind", "contact_email", "message", "token_hash", "change_token_hash", "preview_digest", "state", "sent_at", "expires_at", "change_expires_at", "reminded_at", "answered_at", "cancelled_at", "expired_at", "tokens_deleted_at", "updated_seq", "actor_id") SELECT "id", "party_id", "requested_by", "kind", "contact_email", "message", "token_hash", "change_token_hash", "preview_digest", "state", "sent_at", "expires_at", "change_expires_at", "reminded_at", "answered_at", "cancelled_at", "expired_at", "tokens_deleted_at", "updated_seq", "actor_id" FROM `consent_requests`;--> statement-breakpoint
DROP TABLE `consent_requests`;--> statement-breakpoint
ALTER TABLE `__new_consent_requests` RENAME TO `consent_requests`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `consent_requests_party` ON `consent_requests` (`party_id`,`sent_at`);--> statement-breakpoint
CREATE INDEX `consent_requests_state` ON `consent_requests` (`state`,`sent_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `consent_requests_token` ON `consent_requests` (`token_hash`) WHERE "consent_requests"."token_hash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `consent_requests_change_token` ON `consent_requests` (`change_token_hash`) WHERE "consent_requests"."change_token_hash" IS NOT NULL;