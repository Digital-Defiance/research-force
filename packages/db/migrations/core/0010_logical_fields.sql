CREATE TABLE `field_current` (
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`field_key` text NOT NULL,
	`version_id` text NOT NULL,
	`mirror_sha256` text,
	PRIMARY KEY(`owner_type`, `owner_id`, `field_key`),
	FOREIGN KEY (`version_id`) REFERENCES `field_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `field_current_version` ON `field_current` (`version_id`);--> statement-breakpoint
CREATE TABLE `_field_gc_permits` (
	`version_id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `field_read_leases` (
	`version_id` text NOT NULL,
	`lease_id` text NOT NULL,
	`expires_at` text NOT NULL,
	PRIMARY KEY(`version_id`, `lease_id`),
	FOREIGN KEY (`version_id`) REFERENCES `field_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `field_lease_expiry` ON `field_read_leases` (`expires_at`);--> statement-breakpoint
CREATE TABLE `field_references` (
	`version_id` text NOT NULL,
	`holder_type` text NOT NULL,
	`holder_id` text NOT NULL,
	`slot` text NOT NULL,
	PRIMARY KEY(`holder_type`, `holder_id`, `slot`),
	FOREIGN KEY (`version_id`) REFERENCES `field_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `field_reference_version` ON `field_references` (`version_id`);--> statement-breakpoint
CREATE TABLE `field_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`field_key` text NOT NULL,
	`manifest_json` text NOT NULL,
	`manifest_sha256` text NOT NULL,
	`sealed` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "field_sealed_value" CHECK("field_versions"."sealed" IN (0,1)),
	CONSTRAINT "field_manifest_bytes" CHECK(length(CAST("field_versions"."manifest_json" AS BLOB)) <= 512000)
);
--> statement-breakpoint
CREATE INDEX `field_owner` ON `field_versions` (`owner_type`,`owner_id`,`field_key`);--> statement-breakpoint
CREATE TABLE `revision_field_snapshots` (
	`revision_id` text PRIMARY KEY NOT NULL,
	`prev_json` text NOT NULL,
	CONSTRAINT "revision_snapshot_bytes" CHECK(length(CAST("revision_field_snapshots"."prev_json" AS BLOB)) <= 512000)
);
--> statement-breakpoint
CREATE TABLE `span_manifest_parts` (
	`version_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`payload_json` text NOT NULL,
	`sha256` text NOT NULL,
	PRIMARY KEY(`version_id`, `ordinal`),
	FOREIGN KEY (`version_id`) REFERENCES `field_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "span_part_bytes" CHECK(length(CAST("span_manifest_parts"."payload_json" AS BLOB)) <= 128000),
	CONSTRAINT "span_part_ordinal" CHECK("span_manifest_parts"."ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE `text_fragments` (
	`version_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`payload_json` text NOT NULL,
	`sha256` text NOT NULL,
	PRIMARY KEY(`version_id`, `ordinal`),
	FOREIGN KEY (`version_id`) REFERENCES `field_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "text_fragment_bytes" CHECK(length(CAST("text_fragments"."payload_json" AS BLOB)) <= 128000),
	CONSTRAINT "text_fragment_ordinal" CHECK("text_fragments"."ordinal" >= 0)
);
--> statement-breakpoint
CREATE TRIGGER field_version_seal BEFORE UPDATE ON field_versions BEGIN
  SELECT CASE WHEN NOT (OLD.sealed = 0 AND NEW.sealed = 1 AND OLD.id = NEW.id AND OLD.owner_type = NEW.owner_type AND OLD.owner_id = NEW.owner_id AND OLD.field_key = NEW.field_key AND OLD.manifest_json = NEW.manifest_json AND OLD.manifest_sha256 = NEW.manifest_sha256 AND OLD.created_at = NEW.created_at)
    THEN RAISE(ABORT, 'field_version_immutable') END;
  SELECT CASE WHEN (SELECT count(*) FROM text_fragments WHERE version_id = OLD.id) != (SELECT count(*) FROM json_each(NEW.manifest_json, '$.fragments') WHERE value ->> '$.kind' = 'text')
    OR (SELECT count(*) FROM span_manifest_parts WHERE version_id = OLD.id) != (SELECT count(*) FROM json_each(NEW.manifest_json, '$.fragments') WHERE value ->> '$.kind' = 'spans')
    OR EXISTS (SELECT 1 FROM json_each(NEW.manifest_json, '$.fragments') m WHERE CASE WHEN m.value ->> '$.kind' = 'text'
      THEN NOT EXISTS (SELECT 1 FROM text_fragments p WHERE p.version_id = OLD.id AND p.ordinal = m.value ->> '$.ordinal' AND p.sha256 = m.value ->> '$.sha256')
      ELSE NOT EXISTS (SELECT 1 FROM span_manifest_parts p WHERE p.version_id = OLD.id AND p.ordinal = m.value ->> '$.ordinal' AND p.sha256 = m.value ->> '$.sha256') END)
    THEN RAISE(ABORT, 'field_version_incomplete') END;
END;
--> statement-breakpoint
CREATE TRIGGER field_version_insert BEFORE INSERT ON field_versions WHEN NEW.sealed != 0 BEGIN SELECT RAISE(ABORT, 'field_version_must_prepare'); END;
--> statement-breakpoint
CREATE TRIGGER field_version_delete BEFORE DELETE ON field_versions BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM _field_gc_permits WHERE version_id = OLD.id)
    OR EXISTS (SELECT 1 FROM field_current WHERE version_id = OLD.id)
    OR EXISTS (SELECT 1 FROM field_references WHERE version_id = OLD.id)
    OR EXISTS (SELECT 1 FROM field_read_leases l JOIN _field_gc_permits p ON p.version_id = l.version_id WHERE l.version_id = OLD.id AND l.expires_at > p.at)
    THEN RAISE(ABORT, 'field_version_retained') END;
END;
--> statement-breakpoint
CREATE TRIGGER text_fragment_insert BEFORE INSERT ON text_fragments WHEN NOT EXISTS (SELECT 1 FROM field_versions WHERE id = NEW.version_id AND sealed = 0) BEGIN SELECT RAISE(ABORT, 'field_version_sealed'); END;
--> statement-breakpoint
CREATE TRIGGER span_part_insert BEFORE INSERT ON span_manifest_parts WHEN NOT EXISTS (SELECT 1 FROM field_versions WHERE id = NEW.version_id AND sealed = 0) BEGIN SELECT RAISE(ABORT, 'field_version_sealed'); END;
--> statement-breakpoint
CREATE TRIGGER text_fragment_update BEFORE UPDATE ON text_fragments BEGIN SELECT RAISE(ABORT, 'field_version_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER span_part_update BEFORE UPDATE ON span_manifest_parts BEGIN SELECT RAISE(ABORT, 'field_version_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER text_fragment_delete BEFORE DELETE ON text_fragments WHEN NOT EXISTS (SELECT 1 FROM _field_gc_permits WHERE version_id = OLD.version_id) BEGIN SELECT RAISE(ABORT, 'field_version_retained'); END;
--> statement-breakpoint
CREATE TRIGGER span_part_delete BEFORE DELETE ON span_manifest_parts WHEN NOT EXISTS (SELECT 1 FROM _field_gc_permits WHERE version_id = OLD.version_id) BEGIN SELECT RAISE(ABORT, 'field_version_retained'); END;
--> statement-breakpoint
CREATE TRIGGER field_current_insert BEFORE INSERT ON field_current WHEN NOT EXISTS (SELECT 1 FROM field_versions WHERE id = NEW.version_id AND sealed = 1 AND owner_type = NEW.owner_type AND owner_id = NEW.owner_id AND field_key = NEW.field_key) BEGIN SELECT RAISE(ABORT, 'field_reference_mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER field_current_update BEFORE UPDATE ON field_current WHEN NOT EXISTS (SELECT 1 FROM field_versions WHERE id = NEW.version_id AND sealed = 1 AND owner_type = NEW.owner_type AND owner_id = NEW.owner_id AND field_key = NEW.field_key) BEGIN SELECT RAISE(ABORT, 'field_reference_mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER field_reference_insert BEFORE INSERT ON field_references WHEN NOT EXISTS (SELECT 1 FROM field_versions WHERE id = NEW.version_id AND sealed = 1) BEGIN SELECT RAISE(ABORT, 'field_reference_unsealed'); END;
--> statement-breakpoint
CREATE TRIGGER field_reference_update BEFORE UPDATE ON field_references WHEN NOT EXISTS (SELECT 1 FROM field_versions WHERE id = NEW.version_id AND sealed = 1) BEGIN SELECT RAISE(ABORT, 'field_reference_unsealed'); END;
--> statement-breakpoint
CREATE TRIGGER revision_snapshot_update BEFORE UPDATE ON revision_field_snapshots BEGIN SELECT RAISE(ABORT, 'revision_snapshot_immutable'); END;
--> statement-breakpoint
-- Operational only: excluded from authoritative recovery inventories; it contains cursors, never research bodies.
CREATE TABLE field_backfill_state(id TEXT PRIMARY KEY NOT NULL, definition_sha256 TEXT NOT NULL, cursor_json TEXT NOT NULL, generation INTEGER NOT NULL);
--> statement-breakpoint
CREATE TRIGGER field_reference_no_move BEFORE UPDATE ON field_references WHEN OLD.version_id<>NEW.version_id OR OLD.holder_type<>NEW.holder_type OR OLD.holder_id<>NEW.holder_id OR OLD.slot<>NEW.slot BEGIN SELECT RAISE(ABORT,'field_reference_immutable'); END;
