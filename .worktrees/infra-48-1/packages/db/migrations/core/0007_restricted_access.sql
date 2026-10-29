-- Restricted access (R47): the Access_Level column, the Access_List table, its guard, the Revision_Kind
-- access_change, and the Permissions of tasks 52 to 55. SQLite cannot change a CHECK constraint, so revisions,
-- role_permissions, and research_items are rebuilt; dropping revisions removes its revisions_immutable trigger
-- from 0001_raw.sql, which is recreated below. None of these tables has foreign keys.
CREATE TABLE `access_grants` (
	`root_id` text NOT NULL,
	`member_id` text NOT NULL,
	`granted_by` text NOT NULL,
	`granted_at` text NOT NULL,
	PRIMARY KEY(`root_id`, `member_id`)
);
--> statement-breakpoint
CREATE INDEX `access_grants_member` ON `access_grants` (`member_id`);--> statement-breakpoint
CREATE TABLE `_g_access_owner` (
	`x` integer NOT NULL
);
--> statement-breakpoint
PRAGMA defer_foreign_keys = on;--> statement-breakpoint
CREATE TABLE `__new_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`root_id` text,
	`kind` text NOT NULL,
	`member_id` text NOT NULL,
	`at` text NOT NULL,
	`reason` text,
	`prev` text NOT NULL,
	`restored_point` text,
	`ai` text,
	`seq` integer NOT NULL,
	CONSTRAINT "revisions_target_values" CHECK("__new_revisions"."target_type" IN ('unit', 'project', 'policy_page')),
	CONSTRAINT "revisions_kind_values" CHECK("__new_revisions"."kind" IN ('minor_edit', 'correction', 'status_change', 'withdrawal', 'disclosure_change', 'access_change', 'restoration', 'deletion'))
);
--> statement-breakpoint
INSERT INTO `__new_revisions`("id", "target_type", "target_id", "root_id", "kind", "member_id", "at", "reason", "prev", "restored_point", "ai", "seq") SELECT "id", "target_type", "target_id", "root_id", "kind", "member_id", "at", "reason", "prev", "restored_point", "ai", "seq" FROM `revisions`;--> statement-breakpoint
DROP TABLE `revisions`;--> statement-breakpoint
ALTER TABLE `__new_revisions` RENAME TO `revisions`;--> statement-breakpoint
CREATE INDEX `rev_target` ON `revisions` (`target_type`,`target_id`,`at`);--> statement-breakpoint
CREATE INDEX `rev_root` ON `revisions` (`root_id`,`at`);--> statement-breakpoint
-- No API changes a Revision; only the permanent-deletion job deletes Revision rows (R22.11).
CREATE TRIGGER `revisions_immutable` BEFORE UPDATE ON `revisions`
BEGIN SELECT RAISE(ABORT, 'revisions are immutable'); END;
--> statement-breakpoint
CREATE TABLE `__new_role_permissions` (
	`role_id` text NOT NULL,
	`permission` text NOT NULL,
	`scope` text NOT NULL,
	PRIMARY KEY(`role_id`, `permission`),
	CONSTRAINT "role_permissions_permission_values" CHECK("__new_role_permissions"."permission" IN ('item.create', 'attachment.upload', 'reply.post', 'topic.create', 'item.edit', 'item.correct', 'item.withdraw', 'section.edit', 'logSummary.write', 'item.delete', 'link.add', 'link.remove', 'review.request', 'review.complete', 'party.doNotName.on', 'party.doNotName.off', 'profile.edit', 'dissent.attach', 'dissent.edit', 'dissent.withdraw', 'dissent.delete', 'ai.draft.logSummary', 'ai.draft.publicSummary', 'ai.draft.disclosureLine', 'disclosure.set', 'project.create', 'project.edit', 'item.move', 'moderation.decide', 'member.invite', 'member.role', 'member.revoke', 'role.add', 'role.edit', 'valueSet.manage', 'rights.markPublication', 'methods.describe', 'policy.edit', 'settings.edit', 'import.run', 'export.manage', 'backup.manage', 'access.restrict', 'access.widen', 'hold.place', 'hold.lift', 'consent.give', 'consent.propose', 'dual.propose', 'dual.approve', 'dual.decline', 'attachment.move')),
	CONSTRAINT "role_permissions_scope_values" CHECK("__new_role_permissions"."scope" IN ('any', 'own', 'other', 'eligible'))
);
--> statement-breakpoint
INSERT INTO `__new_role_permissions`("role_id", "permission", "scope") SELECT "role_id", "permission", "scope" FROM `role_permissions`;--> statement-breakpoint
DROP TABLE `role_permissions`;--> statement-breakpoint
ALTER TABLE `__new_role_permissions` RENAME TO `role_permissions`;--> statement-breakpoint
-- The built-in Roles receive the Permissions this migration adds, as packages/domain/src/permissions.ts assigns them.
INSERT INTO `role_permissions` (`role_id`, `permission`, `scope`) VALUES
('00000000000000000000000006', 'access.restrict', 'own'),
('00000000000000000000000006', 'access.widen', 'own'),
('00000000000000000000000006', 'attachment.move', 'own'),
('00000000000000000000000006', 'consent.give', 'own'),
('00000000000000000000000006', 'hold.lift', 'own'),
('00000000000000000000000006', 'hold.place', 'any'),
('00000000000000000000000007', 'access.restrict', 'any'),
('00000000000000000000000007', 'access.widen', 'own'),
('00000000000000000000000007', 'attachment.move', 'any'),
('00000000000000000000000007', 'consent.give', 'own'),
('00000000000000000000000007', 'consent.propose', 'any'),
('00000000000000000000000007', 'dual.approve', 'any'),
('00000000000000000000000007', 'dual.decline', 'any'),
('00000000000000000000000007', 'dual.propose', 'any'),
('00000000000000000000000007', 'hold.lift', 'own'),
('00000000000000000000000007', 'hold.place', 'any');
--> statement-breakpoint
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
	CONSTRAINT "research_items_kind_values" CHECK("__new_research_items"."kind" IN ('journal_entry', 'finding', 'source', 'run', 'hypothesis', 'correspondence', 'archival_request', 'topic')),
	CONSTRAINT "research_items_presentation_values" CHECK("__new_research_items"."public_presentation" IN ('summary_only', 'full_content')),
	CONSTRAINT "research_items_access_values" CHECK("__new_research_items"."access_level" IN ('whole_team', 'restricted'))
);
--> statement-breakpoint
INSERT INTO `__new_research_items`("unit_id", "kind", "item_identifier", "project_id", "title", "status_value_id", "item_date_key", "log_date_key", "log_date_is_creation", "log_summary", "log_summary_spans", "public_summary", "public_summary_spans", "public_presentation", "first_public_at", "import_key", "import_row_key") SELECT "unit_id", "kind", "item_identifier", "project_id", "title", "status_value_id", "item_date_key", "log_date_key", "log_date_is_creation", "log_summary", "log_summary_spans", "public_summary", "public_summary_spans", "public_presentation", "first_public_at", "import_key", "import_row_key" FROM `research_items`;--> statement-breakpoint
DROP TABLE `research_items`;--> statement-breakpoint
ALTER TABLE `__new_research_items` RENAME TO `research_items`;--> statement-breakpoint
CREATE UNIQUE INDEX `research_items_identifier` ON `research_items` (`item_identifier`);--> statement-breakpoint
CREATE UNIQUE INDEX `research_items_import_row_key` ON `research_items` (`import_row_key`) WHERE "research_items"."import_row_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `research_items_log` ON `research_items` (`project_id`,`log_date_key`);--> statement-breakpoint
CREATE INDEX `research_items_kind` ON `research_items` (`kind`,`project_id`);--> statement-breakpoint
CREATE INDEX `research_items_import_key` ON `research_items` (`project_id`,`import_key`);--> statement-breakpoint
PRAGMA defer_foreign_keys = off;
