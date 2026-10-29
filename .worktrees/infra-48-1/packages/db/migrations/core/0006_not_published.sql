-- The Disclosure_Level formerly stored as 'private' is 'not_published'. SQLite cannot change a CHECK constraint, so
-- projects and units are rebuilt with their rows mapped; neither table has foreign keys or triggers.
PRAGMA defer_foreign_keys = on;--> statement-breakpoint
CREATE TABLE `__new_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`short_description` text NOT NULL,
	`slug` text NOT NULL,
	`slug_fixed_at` text,
	`featured` integer DEFAULT false NOT NULL,
	`position` integer NOT NULL,
	`accent` text,
	`disclosure_level` text DEFAULT 'not_published' NOT NULL,
	`disclosure_line` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`rev` integer DEFAULT 1 NOT NULL,
	`updated_seq` integer NOT NULL,
	`actor_id` text,
	CONSTRAINT "projects_level_values" CHECK("__new_projects"."disclosure_level" IN ('public', 'withheld', 'not_published')),
	CONSTRAINT "projects_withheld_line" CHECK("__new_projects"."disclosure_level" <> 'withheld' OR "__new_projects"."disclosure_line" IS NOT NULL)
);
--> statement-breakpoint
INSERT INTO `__new_projects`("id", "name", "name_key", "short_description", "slug", "slug_fixed_at", "featured", "position", "accent", "disclosure_level", "disclosure_line", "created_by", "created_at", "rev", "updated_seq", "actor_id") SELECT "id", "name", "name_key", "short_description", "slug", "slug_fixed_at", "featured", "position", "accent", CASE "disclosure_level" WHEN 'private' THEN 'not_published' ELSE "disclosure_level" END, "disclosure_line", "created_by", "created_at", "rev", "updated_seq", "actor_id" FROM `projects`;--> statement-breakpoint
DROP TABLE `projects`;--> statement-breakpoint
ALTER TABLE `__new_projects` RENAME TO `projects`;--> statement-breakpoint
PRAGMA defer_foreign_keys = off;--> statement-breakpoint
CREATE UNIQUE INDEX `projects_name_key` ON `projects` (`name_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug` ON `projects` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_position` ON `projects` (`position`);--> statement-breakpoint
CREATE INDEX `projects_seq` ON `projects` (`updated_seq`);--> statement-breakpoint
CREATE TABLE `__new_units` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_type` text NOT NULL,
	`project_id` text NOT NULL,
	`root_id` text NOT NULL,
	`parent_id` text,
	`position` integer DEFAULT 0 NOT NULL,
	`owner_id` text NOT NULL,
	`credit` text NOT NULL,
	`submission_id` text NOT NULL,
	`created_at` text NOT NULL,
	`created_ai` text,
	`disclosure_level` text DEFAULT 'not_published' NOT NULL,
	`classification_state` text,
	`classified_by` text,
	`classified_at` text,
	`disclosure_line` text,
	`withdrawn_at` text,
	`withdrawn_by` text,
	`withdrawal_reason` text,
	`rev` integer DEFAULT 1 NOT NULL,
	`updated_seq` integer NOT NULL,
	`actor_id` text,
	CONSTRAINT "units_type_values" CHECK("__new_units"."unit_type" IN ('research_item', 'entry_section', 'attachment', 'reply', 'dissent_note')),
	CONSTRAINT "units_level_values" CHECK("__new_units"."disclosure_level" IN ('public', 'withheld', 'not_published')),
	CONSTRAINT "units_classification_values" CHECK("__new_units"."classification_state" IS NULL OR "__new_units"."classification_state" IN ('unclassified', 'classified')),
	CONSTRAINT "units_withheld_line" CHECK("__new_units"."disclosure_level" <> 'withheld' OR "__new_units"."disclosure_line" IS NOT NULL),
	CONSTRAINT "units_unclassified_not_published" CHECK("__new_units"."classification_state" IS NOT 'unclassified' OR "__new_units"."disclosure_level" = 'not_published'),
	CONSTRAINT "units_root_shape" CHECK(("__new_units"."unit_type" = 'research_item') = ("__new_units"."root_id" = "__new_units"."id" AND "__new_units"."parent_id" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_units`("id", "unit_type", "project_id", "root_id", "parent_id", "position", "owner_id", "credit", "submission_id", "created_at", "created_ai", "disclosure_level", "classification_state", "classified_by", "classified_at", "disclosure_line", "withdrawn_at", "withdrawn_by", "withdrawal_reason", "rev", "updated_seq", "actor_id") SELECT "id", "unit_type", "project_id", "root_id", "parent_id", "position", "owner_id", "credit", "submission_id", "created_at", "created_ai", CASE "disclosure_level" WHEN 'private' THEN 'not_published' ELSE "disclosure_level" END, "classification_state", "classified_by", "classified_at", "disclosure_line", "withdrawn_at", "withdrawn_by", "withdrawal_reason", "rev", "updated_seq", "actor_id" FROM `units`;--> statement-breakpoint
DROP TABLE `units`;--> statement-breakpoint
ALTER TABLE `__new_units` RENAME TO `units`;--> statement-breakpoint
CREATE INDEX `units_root` ON `units` (`root_id`,`unit_type`);--> statement-breakpoint
CREATE INDEX `units_parent` ON `units` (`parent_id`,`position`);--> statement-breakpoint
CREATE INDEX `units_project` ON `units` (`project_id`,`unit_type`);--> statement-breakpoint
CREATE INDEX `units_submission` ON `units` (`submission_id`);--> statement-breakpoint
CREATE INDEX `units_seq` ON `units` (`updated_seq`);--> statement-breakpoint
CREATE INDEX `units_unclassified` ON `units` (`classification_state`,`root_id`);