CREATE TABLE `question_entries` (
	`group_id` text NOT NULL,
	`question_id` text NOT NULL,
	`position` integer NOT NULL,
	`target_id` text NOT NULL,
	`cross_link_id` text NOT NULL,
	PRIMARY KEY(`group_id`, `position`),
	CONSTRAINT "question_entries_position_range" CHECK("question_entries"."position" >= 0 AND "question_entries"."position" < 200)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `question_entries_target` ON `question_entries` (`question_id`,`target_id`);--> statement-breakpoint
CREATE INDEX `question_entries_target_question` ON `question_entries` (`target_id`);--> statement-breakpoint
CREATE TABLE `question_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`question_id` text NOT NULL,
	`position` integer NOT NULL,
	`heading` text NOT NULL,
	CONSTRAINT "question_groups_position_range" CHECK("question_groups"."position" >= 0 AND "question_groups"."position" < 20)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `question_groups_position` ON `question_groups` (`question_id`,`position`);--> statement-breakpoint
CREATE TABLE `research_questions` (
	`unit_id` text PRIMARY KEY NOT NULL,
	`question` text NOT NULL,
	`introduction` text,
	`introduction_spans` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
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
	CONSTRAINT "research_items_kind_values" CHECK("__new_research_items"."kind" IN ('journal_entry', 'finding', 'source', 'run', 'hypothesis', 'correspondence', 'archival_request', 'topic', 'research_question')),
	CONSTRAINT "research_items_presentation_values" CHECK("__new_research_items"."public_presentation" IN ('summary_only', 'full_content')),
	CONSTRAINT "research_items_access_values" CHECK("__new_research_items"."access_level" IN ('whole_team', 'restricted'))
);
--> statement-breakpoint
INSERT INTO `__new_research_items`("unit_id", "kind", "item_identifier", "project_id", "title", "status_value_id", "item_date_key", "log_date_key", "log_date_is_creation", "log_summary", "log_summary_spans", "public_summary", "public_summary_spans", "public_presentation", "first_public_at", "import_key", "import_row_key", "access_level") SELECT "unit_id", "kind", "item_identifier", "project_id", "title", "status_value_id", "item_date_key", "log_date_key", "log_date_is_creation", "log_summary", "log_summary_spans", "public_summary", "public_summary_spans", "public_presentation", "first_public_at", "import_key", "import_row_key", "access_level" FROM `research_items`;--> statement-breakpoint
DROP TABLE `research_items`;--> statement-breakpoint
ALTER TABLE `__new_research_items` RENAME TO `research_items`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `research_items_identifier` ON `research_items` (`item_identifier`);--> statement-breakpoint
CREATE UNIQUE INDEX `research_items_import_row_key` ON `research_items` (`import_row_key`) WHERE "research_items"."import_row_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `research_items_log` ON `research_items` (`project_id`,`log_date_key`);--> statement-breakpoint
CREATE INDEX `research_items_kind` ON `research_items` (`kind`,`project_id`);--> statement-breakpoint
CREATE INDEX `research_items_import_key` ON `research_items` (`project_id`,`import_key`);--> statement-breakpoint
ALTER TABLE `projects` ADD `question_order` text DEFAULT '[]' NOT NULL;
