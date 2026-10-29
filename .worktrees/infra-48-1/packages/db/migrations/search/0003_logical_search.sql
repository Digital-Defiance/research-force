CREATE TABLE `logical_search_bodies` (
	`version_id` text NOT NULL,
	`kind` text NOT NULL,
	`ordinal` integer NOT NULL,
	`payload_json` text NOT NULL,
	`sha256` text NOT NULL,
	PRIMARY KEY(`version_id`, `kind`, `ordinal`)
);
--> statement-breakpoint
CREATE TABLE `logical_search_heads` (
	`doc_key` integer PRIMARY KEY NOT NULL,
	`version_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `logical_search_parts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`version_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`start_utf16` integer NOT NULL,
	`end_utf16` integer NOT NULL,
	`body` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `logical_search_part_version` ON `logical_search_parts` (`version_id`,`ordinal`);--> statement-breakpoint
CREATE TABLE `logical_search_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`doc_key` integer NOT NULL,
	`manifest_json` text NOT NULL,
	`sha256` text NOT NULL,
	`sealed` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `logical_search_doc` ON `logical_search_versions` (`doc_key`);--> statement-breakpoint
CREATE VIRTUAL TABLE logical_search_fts USING fts5(body,content='logical_search_parts',content_rowid='id',tokenize='ascii',prefix='2 3 4');
--> statement-breakpoint
CREATE TRIGGER logical_search_part_insert AFTER INSERT ON logical_search_parts BEGIN INSERT INTO logical_search_fts(rowid,body) VALUES(NEW.id,NEW.body); END;
--> statement-breakpoint
CREATE TRIGGER logical_search_part_delete AFTER DELETE ON logical_search_parts BEGIN INSERT INTO logical_search_fts(logical_search_fts,rowid,body) VALUES('delete',OLD.id,OLD.body); END;
--> statement-breakpoint
CREATE TRIGGER logical_search_body_limit BEFORE INSERT ON logical_search_bodies WHEN length(CAST(NEW.payload_json AS BLOB))>128000 BEGIN SELECT RAISE(ABORT,'logical_search_piece_too_large'); END;
--> statement-breakpoint
CREATE TRIGGER logical_search_index_limit BEFORE INSERT ON logical_search_parts WHEN length(CAST(NEW.body AS BLOB))>128000 BEGIN SELECT RAISE(ABORT,'logical_search_index_too_large'); END;
--> statement-breakpoint
CREATE TRIGGER logical_search_head_insert BEFORE INSERT ON logical_search_heads WHEN NOT EXISTS(SELECT 1 FROM logical_search_versions WHERE id=NEW.version_id AND doc_key=NEW.doc_key AND sealed=1) BEGIN SELECT RAISE(ABORT,'logical_search_unsealed'); END;
--> statement-breakpoint
CREATE TRIGGER logical_search_head_update BEFORE UPDATE ON logical_search_heads WHEN NOT EXISTS(SELECT 1 FROM logical_search_versions WHERE id=NEW.version_id AND doc_key=NEW.doc_key AND sealed=1) BEGIN SELECT RAISE(ABORT,'logical_search_unsealed'); END;
--> statement-breakpoint
CREATE TRIGGER logical_body_prepared BEFORE INSERT ON logical_search_bodies WHEN NOT EXISTS(SELECT 1 FROM logical_search_versions WHERE id=NEW.version_id AND sealed=0) BEGIN SELECT RAISE(ABORT,'logical_search_sealed'); END;
--> statement-breakpoint
CREATE TRIGGER logical_part_prepared BEFORE INSERT ON logical_search_parts WHEN NOT EXISTS(SELECT 1 FROM logical_search_versions WHERE id=NEW.version_id AND sealed=0) BEGIN SELECT RAISE(ABORT,'logical_search_sealed'); END;
--> statement-breakpoint
CREATE TRIGGER logical_body_immutable BEFORE UPDATE ON logical_search_bodies BEGIN SELECT RAISE(ABORT,'logical_search_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER logical_part_immutable BEFORE UPDATE ON logical_search_parts BEGIN SELECT RAISE(ABORT,'logical_search_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER logical_version_seal BEFORE UPDATE ON logical_search_versions WHEN NOT(OLD.sealed=0 AND NEW.sealed=1 AND OLD.id=NEW.id AND OLD.doc_key=NEW.doc_key AND OLD.manifest_json=NEW.manifest_json AND OLD.sha256=NEW.sha256) BEGIN SELECT RAISE(ABORT,'logical_search_immutable'); END;
