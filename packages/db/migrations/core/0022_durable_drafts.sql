CREATE TABLE `draft_events` (
	`id` text PRIMARY KEY NOT NULL,
	`draft_id` text NOT NULL,
	`kind` text NOT NULL,
	`at` text NOT NULL,
	`actor_id` text,
	`reason` text,
	CONSTRAINT "draft_events_kind_values" CHECK("draft_events"."kind" IN ('created', 'saved', 'pinned', 'unpinned', 'warned', 'expired', 'discarded', 'recovered')),
	CONSTRAINT "draft_events_reason" CHECK("draft_events"."reason" IS NULL OR "draft_events"."kind" = 'recovered')
);
--> statement-breakpoint
CREATE INDEX `draft_events_draft` ON `draft_events` (`draft_id`,`at`);--> statement-breakpoint
CREATE TABLE `_g_draft_author` (
	`x` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `saved_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`author_id` text NOT NULL,
	`kind` text NOT NULL,
	`form` text NOT NULL,
	`target_id` text,
	`target_root_id` text,
	`base_rev` integer,
	`content` text NOT NULL,
	`upload_group` text,
	`pinned` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`last_saved_at` text NOT NULL,
	`warned_at` text,
	`rev` integer DEFAULT 1 NOT NULL,
	`updated_seq` integer NOT NULL,
	`actor_id` text,
	CONSTRAINT "saved_drafts_kind_values" CHECK("saved_drafts"."kind" IN ('item', 'edit', 'submission', 'reply', 'proposal')),
	CONSTRAINT "saved_drafts_edit_target" CHECK("saved_drafts"."kind" <> 'edit' OR "saved_drafts"."target_id" IS NOT NULL),
	CONSTRAINT "saved_drafts_target_root" CHECK("saved_drafts"."target_id" IS NULL OR "saved_drafts"."target_root_id" IS NOT NULL),
	CONSTRAINT "saved_drafts_base_rev" CHECK("saved_drafts"."base_rev" IS NULL OR "saved_drafts"."target_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `saved_drafts_author` ON `saved_drafts` (`author_id`,`last_saved_at`);--> statement-breakpoint
CREATE INDEX `saved_drafts_target` ON `saved_drafts` (`target_id`);--> statement-breakpoint
CREATE INDEX `saved_drafts_expiry` ON `saved_drafts` (`pinned`,`last_saved_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_role_permissions` (
	`role_id` text NOT NULL,
	`permission` text NOT NULL,
	`scope` text NOT NULL,
	PRIMARY KEY(`role_id`, `permission`),
	CONSTRAINT "role_permissions_permission_values" CHECK("__new_role_permissions"."permission" IN ('item.create', 'attachment.upload', 'reply.post', 'topic.create', 'item.edit', 'item.correct', 'item.withdraw', 'section.edit', 'logSummary.write', 'item.delete', 'link.add', 'link.remove', 'review.request', 'review.complete', 'party.doNotName.on', 'party.doNotName.off', 'profile.edit', 'dissent.attach', 'dissent.edit', 'dissent.withdraw', 'dissent.delete', 'ai.draft.logSummary', 'ai.draft.publicSummary', 'ai.draft.disclosureLine', 'disclosure.set', 'project.create', 'project.edit', 'item.move', 'moderation.decide', 'member.invite', 'member.role', 'member.revoke', 'role.add', 'role.edit', 'valueSet.manage', 'rights.markPublication', 'methods.describe', 'policy.edit', 'settings.edit', 'import.run', 'export.manage', 'backup.manage', 'access.restrict', 'access.widen', 'hold.place', 'hold.lift', 'consent.give', 'consent.propose', 'dual.propose', 'dual.approve', 'dual.decline', 'attachment.move', 'decision.acknowledge', 'work.assign', 'work.edit', 'work.progress', 'work.accept', 'derivation.review', 'draft.recover')),
	CONSTRAINT "role_permissions_scope_values" CHECK("__new_role_permissions"."scope" IN ('any', 'own', 'other', 'eligible'))
);
--> statement-breakpoint
INSERT INTO `__new_role_permissions`("role_id", "permission", "scope") SELECT "role_id", "permission", "scope" FROM `role_permissions`;--> statement-breakpoint
DROP TABLE `role_permissions`;--> statement-breakpoint
ALTER TABLE `__new_role_permissions` RENAME TO `role_permissions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;

--> statement-breakpoint
-- Only the Administrator Role may recover another Member's draft, and then only with a reason and an audit event (R57.2); as packages/domain/src/permissions.ts assigns it.
INSERT INTO `role_permissions` (`role_id`, `permission`, `scope`) VALUES
('00000000000000000000000007', 'draft.recover', 'any');