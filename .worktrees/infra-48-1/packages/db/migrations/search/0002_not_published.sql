-- The Disclosure_Level formerly stored as 'private' is 'not_published'; search_docs is rebuilt with its rows mapped.
-- Dropping the old table drops its full-text triggers, which are recreated below unchanged from 0001_fts.
PRAGMA defer_foreign_keys = on;--> statement-breakpoint
CREATE TABLE `__new_search_docs` (
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
	CONSTRAINT "search_docs_level_values" CHECK("__new_search_docs"."disclosure_level" IN ('public', 'withheld', 'not_published'))
);
--> statement-breakpoint
INSERT INTO `__new_search_docs`("doc_key", "unit_id", "result_unit_id", "root_id", "root_kind", "project_id", "unit_type", "disclosure_level", "created_at", "completed", "withdrawn", "superseded", "title", "body", "spans") SELECT "doc_key", "unit_id", "result_unit_id", "root_id", "root_kind", "project_id", "unit_type", CASE "disclosure_level" WHEN 'private' THEN 'not_published' ELSE "disclosure_level" END, "created_at", "completed", "withdrawn", "superseded", "title", "body", "spans" FROM `search_docs`;--> statement-breakpoint
DROP TABLE `search_docs`;--> statement-breakpoint
ALTER TABLE `__new_search_docs` RENAME TO `search_docs`;--> statement-breakpoint
PRAGMA defer_foreign_keys = off;--> statement-breakpoint
CREATE UNIQUE INDEX `search_docs_unit_id_unique` ON `search_docs` (`unit_id`);--> statement-breakpoint
CREATE INDEX `docs_filters` ON `search_docs` (`project_id`,`root_kind`,`created_at`);--> statement-breakpoint
CREATE INDEX `docs_root` ON `search_docs` (`root_id`);--> statement-breakpoint
CREATE TRIGGER `search_docs_ai` AFTER INSERT ON `search_docs` BEGIN
  INSERT INTO search_fts (rowid, title, body) VALUES (new.doc_key, new.title, new.body);
END;
--> statement-breakpoint
CREATE TRIGGER `search_docs_ad` AFTER DELETE ON `search_docs` BEGIN
  INSERT INTO search_fts (search_fts, rowid, title, body) VALUES ('delete', old.doc_key, old.title, old.body);
END;
--> statement-breakpoint
CREATE TRIGGER `search_docs_au` AFTER UPDATE OF doc_key, title, body ON `search_docs` BEGIN
  INSERT INTO search_fts (search_fts, rowid, title, body) VALUES ('delete', old.doc_key, old.title, old.body);
  INSERT INTO search_fts (rowid, title, body) VALUES (new.doc_key, new.title, new.body);
END;
