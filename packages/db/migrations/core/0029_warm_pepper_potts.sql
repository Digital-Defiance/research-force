CREATE TABLE `consent_answers` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`item_id` text NOT NULL,
	`unit_id` text NOT NULL,
	`root_id` text NOT NULL,
	`choice` text NOT NULL,
	`generic_label` text,
	`comment` text,
	`result_status` text,
	`seen_snapshot_json` text NOT NULL,
	`seen_snapshot_hash` text NOT NULL,
	`answered_at` text NOT NULL,
	`updated_seq` integer NOT NULL,
	`actor_id` text,
	CONSTRAINT "consent_answers_choice_values" CHECK("consent_answers"."choice" IN ('named', 'unnamed', 'refused', 'granted', 'withdrawn')),
	CONSTRAINT "consent_answers_choice" CHECK("consent_answers"."choice" <> 'withdrawn'),
	CONSTRAINT "consent_answers_label" CHECK("consent_answers"."generic_label" IS NULL OR "consent_answers"."choice" = 'unnamed'),
	CONSTRAINT "consent_answers_seen_hash" CHECK(length("consent_answers"."seen_snapshot_hash") = 64),
	CONSTRAINT "consent_answers_result_values" CHECK("consent_answers"."result_status" IS NULL OR "consent_answers"."result_status" IN ('not_asked', 'requested', 'granted', 'refused'))
);
--> statement-breakpoint
CREATE INDEX `consent_answers_request` ON `consent_answers` (`request_id`,`answered_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `consent_answers_item` ON `consent_answers` (`item_id`);--> statement-breakpoint
CREATE INDEX `consent_answers_unit` ON `consent_answers` (`unit_id`,`answered_at`);--> statement-breakpoint
CREATE INDEX `consent_answers_root` ON `consent_answers` (`root_id`);--> statement-breakpoint
CREATE TABLE `consent_request_items` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`unit_id` text NOT NULL,
	`root_id` text NOT NULL,
	`position` integer NOT NULL,
	`proposed_values_json` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`snapshot_hash` text NOT NULL,
	`answer_id` text,
	`updated_seq` integer NOT NULL,
	`actor_id` text,
	CONSTRAINT "consent_request_items_position" CHECK("consent_request_items"."position" >= 0 AND "consent_request_items"."position" < 50),
	CONSTRAINT "consent_request_items_snapshot_hash" CHECK(length("consent_request_items"."snapshot_hash") = 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `consent_request_items_position` ON `consent_request_items` (`request_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `consent_request_items_unit` ON `consent_request_items` (`request_id`,`unit_id`);--> statement-breakpoint
CREATE INDEX `consent_request_items_root` ON `consent_request_items` (`root_id`);--> statement-breakpoint
CREATE INDEX `consent_request_items_unit_lookup` ON `consent_request_items` (`unit_id`);--> statement-breakpoint
CREATE TABLE `consent_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`party_id` text NOT NULL,
	`requested_by` text NOT NULL,
	`kind` text NOT NULL,
	`contact_email` text NOT NULL,
	`message` text,
	`token_hash` text NOT NULL,
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
	CONSTRAINT "consent_requests_kind_values" CHECK("consent_requests"."kind" IN ('publication', 'rights')),
	CONSTRAINT "consent_requests_state_values" CHECK("consent_requests"."state" IN ('sent', 'answered', 'cancelled', 'expired')),
	CONSTRAINT "consent_requests_token_hash" CHECK(length("consent_requests"."token_hash") = 64),
	CONSTRAINT "consent_requests_change_token_hash" CHECK("consent_requests"."change_token_hash" IS NULL OR length("consent_requests"."change_token_hash") = 64),
	CONSTRAINT "consent_requests_preview_digest" CHECK(length("consent_requests"."preview_digest") = 64),
	CONSTRAINT "consent_requests_change_pair" CHECK(("consent_requests"."change_token_hash" IS NULL) = ("consent_requests"."change_expires_at" IS NULL) AND ("consent_requests"."change_token_hash" IS NULL OR "consent_requests"."answered_at" IS NOT NULL)),
	CONSTRAINT "consent_requests_state_stamp" CHECK(("consent_requests"."state" = 'answered') = ("consent_requests"."answered_at" IS NOT NULL) AND ("consent_requests"."state" = 'cancelled') = ("consent_requests"."cancelled_at" IS NOT NULL) AND ("consent_requests"."state" = 'expired') = ("consent_requests"."expired_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `consent_requests_party` ON `consent_requests` (`party_id`,`sent_at`);--> statement-breakpoint
CREATE INDEX `consent_requests_state` ON `consent_requests` (`state`,`sent_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `consent_requests_token` ON `consent_requests` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `consent_requests_change_token` ON `consent_requests` (`change_token_hash`) WHERE "consent_requests"."change_token_hash" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `consent_withdrawals` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`item_id` text NOT NULL,
	`unit_id` text NOT NULL,
	`root_id` text NOT NULL,
	`comment` text,
	`withdrawn_at` text NOT NULL,
	`updated_seq` integer NOT NULL,
	`actor_id` text
);
--> statement-breakpoint
CREATE INDEX `consent_withdrawals_request` ON `consent_withdrawals` (`request_id`,`withdrawn_at`);--> statement-breakpoint
CREATE INDEX `consent_withdrawals_item` ON `consent_withdrawals` (`item_id`,`withdrawn_at`);--> statement-breakpoint
CREATE INDEX `consent_withdrawals_unit` ON `consent_withdrawals` (`unit_id`,`withdrawn_at`);--> statement-breakpoint
CREATE INDEX `consent_withdrawals_root` ON `consent_withdrawals` (`root_id`);--> statement-breakpoint
CREATE TABLE `_g_consent_link_open` (
	`x` integer NOT NULL
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_role_permissions` (
	`role_id` text NOT NULL,
	`permission` text NOT NULL,
	`scope` text NOT NULL,
	PRIMARY KEY(`role_id`, `permission`),
	CONSTRAINT "role_permissions_permission_values" CHECK("__new_role_permissions"."permission" IN ('item.create', 'attachment.upload', 'reply.post', 'topic.create', 'item.edit', 'item.correct', 'item.withdraw', 'section.edit', 'logSummary.write', 'item.delete', 'link.add', 'link.remove', 'review.request', 'review.complete', 'party.doNotName.on', 'party.doNotName.off', 'profile.edit', 'dissent.attach', 'dissent.edit', 'dissent.withdraw', 'dissent.delete', 'ai.draft.logSummary', 'ai.draft.publicSummary', 'ai.draft.disclosureLine', 'disclosure.set', 'project.create', 'project.edit', 'item.move', 'moderation.decide', 'member.invite', 'member.role', 'member.revoke', 'role.add', 'role.edit', 'valueSet.manage', 'rights.markPublication', 'methods.describe', 'policy.edit', 'settings.edit', 'import.run', 'export.manage', 'backup.manage', 'access.restrict', 'access.widen', 'hold.place', 'hold.lift', 'consent.give', 'consent.propose', 'dual.propose', 'dual.approve', 'dual.decline', 'attachment.move', 'decision.acknowledge', 'work.assign', 'work.edit', 'work.progress', 'work.accept', 'derivation.review', 'draft.recover', 'consent.request', 'party.contact')),
	CONSTRAINT "role_permissions_scope_values" CHECK("__new_role_permissions"."scope" IN ('any', 'own', 'other', 'eligible'))
);
--> statement-breakpoint
INSERT INTO `__new_role_permissions`("role_id", "permission", "scope") SELECT "role_id", "permission", "scope" FROM `role_permissions`;--> statement-breakpoint
DROP TABLE `role_permissions`;--> statement-breakpoint
ALTER TABLE `__new_role_permissions` RENAME TO `role_permissions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_external_parties` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_fold` text NOT NULL,
	`do_not_name` integer DEFAULT false NOT NULL,
	`generic_label` text,
	`contact_email` text,
	`contact_email_erased_by` text,
	`contact_email_erased_at` text,
	`created_at` text NOT NULL,
	`rev` integer DEFAULT 1 NOT NULL,
	`updated_seq` integer NOT NULL,
	`actor_id` text,
	CONSTRAINT "external_parties_label" CHECK("__new_external_parties"."do_not_name" = 0 OR "__new_external_parties"."generic_label" IS NOT NULL),
	CONSTRAINT "external_parties_email_erasure" CHECK(("__new_external_parties"."contact_email_erased_by" IS NULL) = ("__new_external_parties"."contact_email_erased_at" IS NULL) AND ("__new_external_parties"."contact_email_erased_at" IS NULL OR "__new_external_parties"."contact_email" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_external_parties`("id", "name", "name_fold", "do_not_name", "generic_label", "created_at", "rev", "updated_seq", "actor_id") SELECT "id", "name", "name_fold", "do_not_name", "generic_label", "created_at", "rev", "updated_seq", "actor_id" FROM `external_parties`;--> statement-breakpoint
DROP TABLE `external_parties`;--> statement-breakpoint
ALTER TABLE `__new_external_parties` RENAME TO `external_parties`;--> statement-breakpoint
CREATE INDEX `external_parties_fold` ON `external_parties` (`name_fold`);--> statement-breakpoint
-- Only the Administrator Role may send Consent_Requests and record or erase a Contact_Email (R2.5, R51.1); as packages/domain/src/permissions.ts assigns them.
INSERT INTO `role_permissions` (`role_id`, `permission`, `scope`) VALUES
('00000000000000000000000007', 'consent.request', 'any'),
('00000000000000000000000007', 'party.contact', 'any');