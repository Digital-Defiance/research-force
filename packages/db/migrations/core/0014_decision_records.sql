CREATE TABLE `decision_acknowledgements` (
	`decision_id` text NOT NULL,
	`member_id` text NOT NULL,
	`version` integer NOT NULL,
	`response` text NOT NULL,
	`digest` text NOT NULL,
	`wording_version` integer NOT NULL,
	`comment` text,
	`at` text NOT NULL,
	PRIMARY KEY(`decision_id`, `member_id`, `version`),
	CONSTRAINT "decision_acknowledgements_response_values" CHECK("decision_acknowledgements"."response" IN ('acknowledged', 'disagreed')),
	CONSTRAINT "decision_acknowledgements_version" CHECK("decision_acknowledgements"."version" >= 1),
	CONSTRAINT "decision_acknowledgements_digest" CHECK(length("decision_acknowledgements"."digest") = 64)
);
--> statement-breakpoint
CREATE TABLE `decision_alternatives` (
	`decision_id` text NOT NULL,
	`position` integer NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	PRIMARY KEY(`decision_id`, `position`),
	CONSTRAINT "decision_alternatives_position" CHECK("decision_alternatives"."position" >= 0 AND "decision_alternatives"."position" < 20)
);
--> statement-breakpoint
CREATE TABLE `decision_evidence` (
	`decision_id` text NOT NULL,
	`citation_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`decision_id`, `citation_id`),
	CONSTRAINT "decision_evidence_position" CHECK("decision_evidence"."position" >= 0 AND "decision_evidence"."position" < 50)
);
--> statement-breakpoint
CREATE INDEX `decision_evidence_citation` ON `decision_evidence` (`citation_id`);--> statement-breakpoint
CREATE TABLE `decision_participants` (
	`decision_id` text NOT NULL,
	`member_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`decision_id`, `member_id`),
	CONSTRAINT "decision_participants_position" CHECK("decision_participants"."position" >= 0 AND "decision_participants"."position" < 50)
);
--> statement-breakpoint
CREATE INDEX `decision_participants_member` ON `decision_participants` (`member_id`);--> statement-breakpoint
CREATE TABLE `decisions` (
	`unit_id` text PRIMARY KEY NOT NULL,
	`question` text NOT NULL,
	`context` text,
	`context_spans` text DEFAULT '[]' NOT NULL,
	`rationale` text,
	`rationale_spans` text DEFAULT '[]' NOT NULL,
	`scope` text DEFAULT 'individual' NOT NULL,
	`state` text DEFAULT 'proposed' NOT NULL,
	`outcome_kind` text,
	`outcome_alternative` integer,
	`outcome_reason` text,
	`revisit_date` text,
	`revisit_condition` text,
	`wording_digest` text NOT NULL,
	`wording_version` integer DEFAULT 1 NOT NULL,
	`adopted_at` text,
	`adopted_by` text,
	`supersedes_id` text,
	`superseded_by_id` text,
	`state_changed_at` text,
	`state_changed_by` text,
	CONSTRAINT "decisions_scope_values" CHECK("decisions"."scope" IN ('individual', 'team')),
	CONSTRAINT "decisions_state_values" CHECK("decisions"."state" IN ('proposed', 'adopted', 'superseded', 'withdrawn')),
	CONSTRAINT "decisions_outcome_values" CHECK("decisions"."outcome_kind" IS NULL OR "decisions"."outcome_kind" IN ('selected', 'deferred')),
	CONSTRAINT "decisions_outcome_shape" CHECK(COALESCE("decisions"."outcome_kind" = 'selected', 0) = ("decisions"."outcome_alternative" IS NOT NULL) AND (COALESCE("decisions"."outcome_kind" = 'deferred', 0) OR "decisions"."outcome_reason" IS NULL)),
	CONSTRAINT "decisions_outcome_range" CHECK("decisions"."outcome_alternative" IS NULL OR ("decisions"."outcome_alternative" >= 0 AND "decisions"."outcome_alternative" < 20)),
	CONSTRAINT "decisions_adopted_pair" CHECK(("decisions"."adopted_at" IS NULL) = ("decisions"."adopted_by" IS NULL)),
	CONSTRAINT "decisions_wording_version" CHECK("decisions"."wording_version" >= 1),
	CONSTRAINT "decisions_digest" CHECK(length("decisions"."wording_digest") = 64)
);
--> statement-breakpoint
CREATE INDEX `decisions_supersedes` ON `decisions` (`supersedes_id`);--> statement-breakpoint
CREATE INDEX `decisions_superseded_by` ON `decisions` (`superseded_by_id`);--> statement-breakpoint
CREATE INDEX `decisions_revisit` ON `decisions` (`revisit_date`);--> statement-breakpoint
CREATE TABLE `_g_acknowledgement_version` (
	`x` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `_g_decision_participant` (
	`x` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `_g_decision_wording` (
	`x` integer NOT NULL
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_role_permissions` (
	`role_id` text NOT NULL,
	`permission` text NOT NULL,
	`scope` text NOT NULL,
	PRIMARY KEY(`role_id`, `permission`),
	CONSTRAINT "role_permissions_permission_values" CHECK("__new_role_permissions"."permission" IN ('item.create', 'attachment.upload', 'reply.post', 'topic.create', 'item.edit', 'item.correct', 'item.withdraw', 'section.edit', 'logSummary.write', 'item.delete', 'link.add', 'link.remove', 'review.request', 'review.complete', 'party.doNotName.on', 'party.doNotName.off', 'profile.edit', 'dissent.attach', 'dissent.edit', 'dissent.withdraw', 'dissent.delete', 'ai.draft.logSummary', 'ai.draft.publicSummary', 'ai.draft.disclosureLine', 'disclosure.set', 'project.create', 'project.edit', 'item.move', 'moderation.decide', 'member.invite', 'member.role', 'member.revoke', 'role.add', 'role.edit', 'valueSet.manage', 'rights.markPublication', 'methods.describe', 'policy.edit', 'settings.edit', 'import.run', 'export.manage', 'backup.manage', 'access.restrict', 'access.widen', 'hold.place', 'hold.lift', 'consent.give', 'consent.propose', 'dual.propose', 'dual.approve', 'dual.decline', 'attachment.move', 'decision.acknowledge')),
	CONSTRAINT "role_permissions_scope_values" CHECK("__new_role_permissions"."scope" IN ('any', 'own', 'other', 'eligible'))
);
--> statement-breakpoint
INSERT INTO `__new_role_permissions`("role_id", "permission", "scope") SELECT "role_id", "permission", "scope" FROM `role_permissions`;--> statement-breakpoint
DROP TABLE `role_permissions`;--> statement-breakpoint
ALTER TABLE `__new_role_permissions` RENAME TO `role_permissions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_research_items` (
	`unit_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`item_identifier` text NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`status_value_id` text,
	`item_date_key` text NOT NULL,
	`log_date_key` text NOT NULL,
	`log_date_is_creation` integer DEFAULT false NOT NULL,
	`log_summary` text,
	`log_summary_spans` text DEFAULT '[]' NOT NULL,
	`public_summary` text,
	`public_summary_spans` text DEFAULT '[]' NOT NULL,
	`public_presentation` text DEFAULT 'summary_only' NOT NULL,
	`first_public_at` text,
	`import_key` text,
	`import_row_key` text,
	`access_level` text DEFAULT 'whole_team' NOT NULL,
	CONSTRAINT "research_items_kind_values" CHECK("__new_research_items"."kind" IN ('journal_entry', 'finding', 'source', 'run', 'hypothesis', 'correspondence', 'archival_request', 'topic', 'research_question', 'decision_record')),
	CONSTRAINT "research_items_presentation_values" CHECK("__new_research_items"."public_presentation" IN ('summary_only', 'full_content')),
	CONSTRAINT "research_items_access_values" CHECK("__new_research_items"."access_level" IN ('whole_team', 'restricted'))
);
--> statement-breakpoint
INSERT INTO `__new_research_items`("unit_id", "kind", "item_identifier", "project_id", "title", "status_value_id", "item_date_key", "log_date_key", "log_date_is_creation", "log_summary", "log_summary_spans", "public_summary", "public_summary_spans", "public_presentation", "first_public_at", "import_key", "import_row_key", "access_level") SELECT "unit_id", "kind", "item_identifier", "project_id", "title", "status_value_id", "item_date_key", "log_date_key", "log_date_is_creation", "log_summary", "log_summary_spans", "public_summary", "public_summary_spans", "public_presentation", "first_public_at", "import_key", "import_row_key", "access_level" FROM `research_items`;--> statement-breakpoint
DROP TABLE `research_items`;--> statement-breakpoint
ALTER TABLE `__new_research_items` RENAME TO `research_items`;--> statement-breakpoint
CREATE UNIQUE INDEX `research_items_identifier` ON `research_items` (`item_identifier`);--> statement-breakpoint
CREATE UNIQUE INDEX `research_items_import_row_key` ON `research_items` (`import_row_key`) WHERE "research_items"."import_row_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `research_items_log` ON `research_items` (`project_id`,`log_date_key`);--> statement-breakpoint
CREATE INDEX `research_items_kind` ON `research_items` (`kind`,`project_id`);--> statement-breakpoint
CREATE INDEX `research_items_import_key` ON `research_items` (`project_id`,`import_key`);--> statement-breakpoint
-- The built-in Roles receive the Permission this migration adds, as packages/domain/src/permissions.ts assigns it: a response is always the Member's own.
INSERT INTO `role_permissions` (`role_id`, `permission`, `scope`) VALUES
('00000000000000000000000006', 'decision.acknowledge', 'own'),
('00000000000000000000000007', 'decision.acknowledge', 'own');--> statement-breakpoint
-- A personal response is added, never changed: a new response is the next version (R53.3).
CREATE TRIGGER `decision_acknowledgements_immutable` BEFORE UPDATE ON `decision_acknowledgements`
BEGIN SELECT RAISE(ABORT, 'decision_acknowledgement_immutable'); END;
