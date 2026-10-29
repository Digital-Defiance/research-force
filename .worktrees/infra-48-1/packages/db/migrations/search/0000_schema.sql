CREATE TABLE `search_credits` (
	`member_id` text NOT NULL,
	`doc_key` integer NOT NULL,
	PRIMARY KEY(`member_id`, `doc_key`)
);
--> statement-breakpoint
CREATE INDEX `search_credits_doc` ON `search_credits` (`doc_key`);--> statement-breakpoint
CREATE TABLE `search_docs` (
	`doc_key` integer PRIMARY KEY NOT NULL,
	`unit_id` text NOT NULL,
	`result_unit_id` text NOT NULL,
	`root_id` text NOT NULL,
	`root_kind` text NOT NULL,
	`project_id` text NOT NULL,
	`unit_type` text NOT NULL,
	`disclosure_level` text NOT NULL,
	`created_at` text NOT NULL,
	`completed` integer NOT NULL,
	`withdrawn` integer DEFAULT false NOT NULL,
	`superseded` integer DEFAULT false NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`spans` text DEFAULT '[]' NOT NULL,
	CONSTRAINT "search_docs_level_values" CHECK("search_docs"."disclosure_level" IN ('public', 'withheld', 'private'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `search_docs_unit_id_unique` ON `search_docs` (`unit_id`);--> statement-breakpoint
CREATE INDEX `docs_filters` ON `search_docs` (`project_id`,`root_kind`,`created_at`);--> statement-breakpoint
CREATE INDEX `docs_root` ON `search_docs` (`root_id`);