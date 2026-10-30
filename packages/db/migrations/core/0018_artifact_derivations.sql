CREATE TABLE `artifact_derivation_inputs` (
	`derivation_id` text NOT NULL,
	`position` integer NOT NULL,
	`input_type` text NOT NULL,
	`input_unit_id` text NOT NULL,
	`input_field` text DEFAULT '' NOT NULL,
	`input_rev` integer,
	`input_sha256` text NOT NULL,
	`gone_at` text,
	PRIMARY KEY(`derivation_id`, `position`),
	CONSTRAINT "derivation_inputs_type_values" CHECK("artifact_derivation_inputs"."input_type" IN ('attachment', 'text')),
	CONSTRAINT "derivation_inputs_position" CHECK("artifact_derivation_inputs"."position" >= 0 AND "artifact_derivation_inputs"."position" < 100),
	CONSTRAINT "derivation_inputs_text_field" CHECK(("artifact_derivation_inputs"."input_type" = 'text') = ("artifact_derivation_inputs"."input_field" <> '')),
	CONSTRAINT "derivation_inputs_hash" CHECK(length("artifact_derivation_inputs"."input_sha256") = 64)
);
--> statement-breakpoint
CREATE INDEX `derivation_inputs_unit` ON `artifact_derivation_inputs` (`input_unit_id`,`input_field`);--> statement-breakpoint
CREATE TABLE `artifact_derivations` (
	`id` text PRIMARY KEY NOT NULL,
	`output_type` text NOT NULL,
	`output_unit_id` text NOT NULL,
	`output_field` text DEFAULT '' NOT NULL,
	`output_rev` integer,
	`output_sha256` text NOT NULL,
	`kind` text NOT NULL,
	`method` text NOT NULL,
	`method_version` text,
	`language` text,
	`uncertainty` text,
	`derived_text` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`review_state` text DEFAULT 'unreviewed' NOT NULL,
	`corrects_id` text,
	`corrected_by` text,
	`corrected_at` text,
	`updated_seq` integer NOT NULL,
	`actor_id` text,
	CONSTRAINT "derivations_kind_values" CHECK("artifact_derivations"."kind" IN ('scan', 'transcription', 'translation', 'ocr', 'extraction', 'other')),
	CONSTRAINT "derivations_review_values" CHECK("artifact_derivations"."review_state" IN ('unreviewed', 'reviewed', 'disputed')),
	CONSTRAINT "derivations_output_values" CHECK("artifact_derivations"."output_type" IN ('attachment', 'text')),
	CONSTRAINT "derivations_text_field" CHECK(("artifact_derivations"."output_type" = 'text') = ("artifact_derivations"."output_field" <> '')),
	CONSTRAINT "derivations_text_rev" CHECK(("artifact_derivations"."output_type" = 'text') = ("artifact_derivations"."output_rev" IS NOT NULL)),
	CONSTRAINT "derivations_derived_text_attachment" CHECK("artifact_derivations"."derived_text" IS NULL OR "artifact_derivations"."output_type" = 'attachment'),
	CONSTRAINT "derivations_hash" CHECK(length("artifact_derivations"."output_sha256") = 64),
	CONSTRAINT "derivations_corrected_pair" CHECK(("artifact_derivations"."corrected_by" IS NULL) = ("artifact_derivations"."corrected_at" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `derivations_output` ON `artifact_derivations` (`output_unit_id`,`output_field`);--> statement-breakpoint
CREATE UNIQUE INDEX `derivations_active_output` ON `artifact_derivations` (`output_unit_id`,`output_field`) WHERE "artifact_derivations"."corrected_by" IS NULL;--> statement-breakpoint
CREATE INDEX `derivations_corrects` ON `artifact_derivations` (`corrects_id`);--> statement-breakpoint
CREATE TABLE `derivation_flags` (
	`derivation_id` text NOT NULL,
	`reviewer_id` text NOT NULL,
	`position` integer NOT NULL,
	`start_offset` integer NOT NULL,
	`end_offset` integer NOT NULL,
	`note` text,
	PRIMARY KEY(`derivation_id`, `reviewer_id`, `position`),
	CONSTRAINT "derivation_flags_position" CHECK("derivation_flags"."position" >= 0 AND "derivation_flags"."position" < 50),
	CONSTRAINT "derivation_flags_range" CHECK("derivation_flags"."start_offset" >= 0 AND "derivation_flags"."end_offset" > "derivation_flags"."start_offset")
);
--> statement-breakpoint
CREATE TABLE `derivation_reviews` (
	`derivation_id` text NOT NULL,
	`reviewer_id` text NOT NULL,
	`state` text NOT NULL,
	`note` text,
	`reviewed_at` text NOT NULL,
	PRIMARY KEY(`derivation_id`, `reviewer_id`),
	CONSTRAINT "derivation_reviews_state_values" CHECK("derivation_reviews"."state" IN ('reviewed', 'disputed'))
);
--> statement-breakpoint
CREATE TABLE `_g_derivation_cycle` (
	`x` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `_g_derivation_tip` (
	`x` integer NOT NULL
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_role_permissions` (
	`role_id` text NOT NULL,
	`permission` text NOT NULL,
	`scope` text NOT NULL,
	PRIMARY KEY(`role_id`, `permission`),
	CONSTRAINT "role_permissions_permission_values" CHECK("__new_role_permissions"."permission" IN ('item.create', 'attachment.upload', 'reply.post', 'topic.create', 'item.edit', 'item.correct', 'item.withdraw', 'section.edit', 'logSummary.write', 'item.delete', 'link.add', 'link.remove', 'review.request', 'review.complete', 'party.doNotName.on', 'party.doNotName.off', 'profile.edit', 'dissent.attach', 'dissent.edit', 'dissent.withdraw', 'dissent.delete', 'ai.draft.logSummary', 'ai.draft.publicSummary', 'ai.draft.disclosureLine', 'disclosure.set', 'project.create', 'project.edit', 'item.move', 'moderation.decide', 'member.invite', 'member.role', 'member.revoke', 'role.add', 'role.edit', 'valueSet.manage', 'rights.markPublication', 'methods.describe', 'policy.edit', 'settings.edit', 'import.run', 'export.manage', 'backup.manage', 'access.restrict', 'access.widen', 'hold.place', 'hold.lift', 'consent.give', 'consent.propose', 'dual.propose', 'dual.approve', 'dual.decline', 'attachment.move', 'decision.acknowledge', 'work.assign', 'work.edit', 'work.progress', 'work.accept', 'derivation.review')),
	CONSTRAINT "role_permissions_scope_values" CHECK("__new_role_permissions"."scope" IN ('any', 'own', 'other', 'eligible'))
);
--> statement-breakpoint
INSERT INTO `__new_role_permissions`("role_id", "permission", "scope") SELECT "role_id", "permission", "scope" FROM `role_permissions`;--> statement-breakpoint
DROP TABLE `role_permissions`;--> statement-breakpoint
ALTER TABLE `__new_role_permissions` RENAME TO `role_permissions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
-- The built-in Roles receive the Permission this migration adds, as packages/domain/src/permissions.ts assigns it.
INSERT INTO `role_permissions` (`role_id`, `permission`, `scope`) VALUES
('00000000000000000000000006', 'derivation.review', 'own'),
('00000000000000000000000007', 'derivation.review', 'own');--> statement-breakpoint
-- Changes whenever the derivation graph changes, so a reader can tell that a graph it read is no longer the current one (R55.2).
INSERT INTO `counters` (`k`, `v`) VALUES ('derivation', 0);--> statement-breakpoint
-- What a derivation recorded never changes: a correction is a new derivation that points back at it, and only the correction link, the review state and a deleted input's tombstone are ever set later (R55.1, R55.2).
CREATE TRIGGER `artifact_derivations_identity` BEFORE UPDATE OF `output_type`, `output_unit_id`, `output_field`, `output_rev`, `output_sha256`, `kind`, `method`, `method_version`, `language`, `uncertainty`, `derived_text`, `created_by`, `created_at`, `corrects_id` ON `artifact_derivations`
BEGIN SELECT RAISE(ABORT, 'derivation_immutable'); END;--> statement-breakpoint
CREATE TRIGGER `artifact_derivation_inputs_identity` BEFORE UPDATE OF `derivation_id`, `position`, `input_type`, `input_unit_id`, `input_field`, `input_rev`, `input_sha256` ON `artifact_derivation_inputs`
BEGIN SELECT RAISE(ABORT, 'derivation_immutable'); END;--> statement-breakpoint
CREATE TRIGGER `artifact_derivations_correction_once` BEFORE UPDATE OF `corrected_by` ON `artifact_derivations` WHEN OLD.`corrected_by` IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'derivation_immutable'); END;
