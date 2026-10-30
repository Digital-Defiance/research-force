CREATE TABLE `question_assessment_evidence` (
	`question_id` text NOT NULL,
	`version` integer NOT NULL,
	`position` integer NOT NULL,
	`target_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_rev` integer NOT NULL,
	`sha256` text NOT NULL,
	PRIMARY KEY(`question_id`, `version`, `position`),
	CONSTRAINT "question_assessment_evidence_position" CHECK("question_assessment_evidence"."position" >= 0 AND "question_assessment_evidence"."position" < 50)
);
--> statement-breakpoint
CREATE INDEX `question_assessment_evidence_target` ON `question_assessment_evidence` (`target_id`);--> statement-breakpoint
CREATE TABLE `question_assessments` (
	`question_id` text NOT NULL,
	`version` integer NOT NULL,
	`state` text NOT NULL,
	`assessment` text,
	`assessment_spans` text DEFAULT '[]' NOT NULL,
	`reason` text,
	`responsible_id` text NOT NULL,
	`recorded_at` text NOT NULL,
	PRIMARY KEY(`question_id`, `version`),
	CONSTRAINT "question_assessments_state_values" CHECK("question_assessments"."state" IN ('open', 'investigating', 'answered', 'parked')),
	CONSTRAINT "question_assessments_version" CHECK("question_assessments"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE `question_next_actions` (
	`question_id` text NOT NULL,
	`position` integer NOT NULL,
	`text` text NOT NULL,
	`work_item_id` text,
	PRIMARY KEY(`question_id`, `position`),
	CONSTRAINT "question_next_actions_position" CHECK("question_next_actions"."position" >= 0 AND "question_next_actions"."position" < 20)
);
--> statement-breakpoint
CREATE INDEX `question_next_actions_work` ON `question_next_actions` (`work_item_id`);--> statement-breakpoint
CREATE TABLE `question_uncertainties` (
	`question_id` text NOT NULL,
	`position` integer NOT NULL,
	`text` text NOT NULL,
	PRIMARY KEY(`question_id`, `position`),
	CONSTRAINT "question_uncertainties_position" CHECK("question_uncertainties"."position" >= 0 AND "question_uncertainties"."position" < 20)
);
--> statement-breakpoint
CREATE TABLE `work_assignees` (
	`work_id` text NOT NULL,
	`member_id` text NOT NULL,
	`position` integer NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`assigned_by` text NOT NULL,
	`assigned_at` text NOT NULL,
	`responded_at` text,
	`response_reason` text,
	PRIMARY KEY(`work_id`, `member_id`),
	CONSTRAINT "work_assignees_state_values" CHECK("work_assignees"."state" IN ('pending', 'accepted', 'declined')),
	CONSTRAINT "work_assignees_position" CHECK("work_assignees"."position" >= 0 AND "work_assignees"."position" < 20),
	CONSTRAINT "work_assignees_response" CHECK(("work_assignees"."state" = 'pending') = ("work_assignees"."responded_at" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `work_assignees_member` ON `work_assignees` (`member_id`,`state`);--> statement-breakpoint
CREATE TABLE `work_dependencies` (
	`work_id` text NOT NULL,
	`predecessor_id` text NOT NULL,
	`position` integer NOT NULL,
	`kind` text DEFAULT 'blocker' NOT NULL,
	`added_by` text NOT NULL,
	`added_at` text NOT NULL,
	PRIMARY KEY(`work_id`, `predecessor_id`),
	CONSTRAINT "work_dependencies_kind_values" CHECK("work_dependencies"."kind" IN ('blocker', 'informational')),
	CONSTRAINT "work_dependencies_position" CHECK("work_dependencies"."position" >= 0 AND "work_dependencies"."position" < 100),
	CONSTRAINT "work_dependencies_self" CHECK("work_dependencies"."work_id" <> "work_dependencies"."predecessor_id")
);
--> statement-breakpoint
CREATE INDEX `work_dependencies_predecessor` ON `work_dependencies` (`predecessor_id`);--> statement-breakpoint
CREATE TABLE `work_items` (
	`unit_id` text PRIMARY KEY NOT NULL,
	`objective` text NOT NULL,
	`objective_spans` text DEFAULT '[]' NOT NULL,
	`responsible_id` text NOT NULL,
	`due_date` text,
	`priority` text DEFAULT 'normal' NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`state_reason` text,
	`state_changed_at` text,
	`state_changed_by` text,
	`graph_rev` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "work_items_priority_values" CHECK("work_items"."priority" IN ('low', 'normal', 'high')),
	CONSTRAINT "work_items_state_values" CHECK("work_items"."state" IN ('open', 'in_progress', 'blocked', 'done', 'cancelled')),
	CONSTRAINT "work_items_state_pair" CHECK(("work_items"."state_changed_at" IS NULL) = ("work_items"."state_changed_by" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `work_items_responsible` ON `work_items` (`responsible_id`,`state`);--> statement-breakpoint
CREATE INDEX `work_items_due` ON `work_items` (`due_date`);--> statement-breakpoint
CREATE TABLE `work_outcome_results` (
	`outcome_id` text NOT NULL,
	`position` integer NOT NULL,
	`target_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_rev` integer,
	`sha256` text,
	PRIMARY KEY(`outcome_id`, `position`),
	CONSTRAINT "work_outcome_results_position" CHECK("work_outcome_results"."position" >= 0 AND "work_outcome_results"."position" < 20)
);
--> statement-breakpoint
CREATE INDEX `work_outcome_results_target` ON `work_outcome_results` (`target_id`);--> statement-breakpoint
CREATE TABLE `work_outcomes` (
	`id` text PRIMARY KEY NOT NULL,
	`work_id` text NOT NULL,
	`seq` integer NOT NULL,
	`transition` text NOT NULL,
	`reason` text,
	`no_result_statement` text,
	`recorded_by` text NOT NULL,
	`recorded_at` text NOT NULL,
	CONSTRAINT "work_outcomes_transition_values" CHECK("work_outcomes"."transition" IN ('done', 'cancelled', 'reopened')),
	CONSTRAINT "work_outcomes_reason" CHECK(("work_outcomes"."transition" = 'done') OR "work_outcomes"."reason" IS NOT NULL),
	CONSTRAINT "work_outcomes_no_result" CHECK("work_outcomes"."no_result_statement" IS NULL OR "work_outcomes"."transition" = 'done')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_outcomes_seq` ON `work_outcomes` (`work_id`,`seq`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_role_permissions` (
	`role_id` text NOT NULL,
	`permission` text NOT NULL,
	`scope` text NOT NULL,
	PRIMARY KEY(`role_id`, `permission`),
	CONSTRAINT "role_permissions_permission_values" CHECK("__new_role_permissions"."permission" IN ('item.create', 'attachment.upload', 'reply.post', 'topic.create', 'item.edit', 'item.correct', 'item.withdraw', 'section.edit', 'logSummary.write', 'item.delete', 'link.add', 'link.remove', 'review.request', 'review.complete', 'party.doNotName.on', 'party.doNotName.off', 'profile.edit', 'dissent.attach', 'dissent.edit', 'dissent.withdraw', 'dissent.delete', 'ai.draft.logSummary', 'ai.draft.publicSummary', 'ai.draft.disclosureLine', 'disclosure.set', 'project.create', 'project.edit', 'item.move', 'moderation.decide', 'member.invite', 'member.role', 'member.revoke', 'role.add', 'role.edit', 'valueSet.manage', 'rights.markPublication', 'methods.describe', 'policy.edit', 'settings.edit', 'import.run', 'export.manage', 'backup.manage', 'access.restrict', 'access.widen', 'hold.place', 'hold.lift', 'consent.give', 'consent.propose', 'dual.propose', 'dual.approve', 'dual.decline', 'attachment.move', 'decision.acknowledge', 'work.assign', 'work.edit', 'work.progress', 'work.accept')),
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
	CONSTRAINT "research_items_kind_values" CHECK("__new_research_items"."kind" IN ('journal_entry', 'finding', 'source', 'run', 'hypothesis', 'correspondence', 'archival_request', 'topic', 'research_question', 'decision_record', 'work_item')),
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
CREATE TABLE `__new_research_questions` (
	`unit_id` text PRIMARY KEY NOT NULL,
	`question` text NOT NULL,
	`introduction` text,
	`introduction_spans` text DEFAULT '[]' NOT NULL,
	`lead_id` text,
	`investigation_state` text DEFAULT 'open' NOT NULL,
	`assessment_version` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "research_questions_state_values" CHECK("__new_research_questions"."investigation_state" IN ('open', 'investigating', 'answered', 'parked'))
);
--> statement-breakpoint
INSERT INTO `__new_research_questions`("unit_id", "question", "introduction", "introduction_spans") SELECT "unit_id", "question", "introduction", "introduction_spans" FROM `research_questions`;--> statement-breakpoint
DROP TABLE `research_questions`;--> statement-breakpoint
ALTER TABLE `__new_research_questions` RENAME TO `research_questions`;--> statement-breakpoint
CREATE INDEX `research_questions_lead` ON `research_questions` (`lead_id`);
--> statement-breakpoint
-- The built-in Roles receive the Permissions this migration adds, as packages/domain/src/permissions.ts assigns them.
INSERT INTO `role_permissions` (`role_id`, `permission`, `scope`) VALUES
('00000000000000000000000006', 'work.accept', 'own'),
('00000000000000000000000006', 'work.assign', 'own'),
('00000000000000000000000006', 'work.edit', 'own'),
('00000000000000000000000006', 'work.progress', 'own'),
('00000000000000000000000007', 'work.accept', 'own'),
('00000000000000000000000007', 'work.assign', 'any'),
('00000000000000000000000007', 'work.edit', 'any'),
('00000000000000000000000007', 'work.progress', 'any');--> statement-breakpoint
-- Outcomes and assessments are added, never changed, so reopening, cancelling or reassessing keeps every earlier conclusion (R50.10, R52.4).
CREATE TRIGGER `work_outcomes_immutable` BEFORE UPDATE ON `work_outcomes`
BEGIN SELECT RAISE(ABORT, 'work_outcome_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `work_outcome_results_immutable` BEFORE UPDATE ON `work_outcome_results`
BEGIN SELECT RAISE(ABORT, 'work_outcome_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `question_assessments_immutable` BEFORE UPDATE ON `question_assessments`
BEGIN SELECT RAISE(ABORT, 'question_assessment_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `question_assessment_evidence_immutable` BEFORE UPDATE ON `question_assessment_evidence`
BEGIN SELECT RAISE(ABORT, 'question_assessment_immutable'); END;
