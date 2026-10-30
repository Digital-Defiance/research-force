CREATE TABLE `release_approvals` (
	`release_id` text NOT NULL,
	`kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`evidence_hash` text NOT NULL,
	`approved_by` text NOT NULL,
	`approved_at` text NOT NULL,
	PRIMARY KEY(`release_id`, `kind`, `subject_id`, `evidence_hash`),
	CONSTRAINT "release_approvals_kind_values" CHECK("release_approvals"."kind" IN ('owner', 'rights', 'administrator')),
	CONSTRAINT "release_approvals_hash" CHECK(length("release_approvals"."evidence_hash") = 64)
);
--> statement-breakpoint
CREATE INDEX `release_approvals_subject` ON `release_approvals` (`subject_id`);--> statement-breakpoint
CREATE TABLE `release_artifacts` (
	`release_id` text NOT NULL,
	`position` integer NOT NULL,
	`kind` text NOT NULL,
	`unit_id` text NOT NULL,
	`root_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`item_kind` text,
	`identifier` text,
	`title` text,
	`revision` integer,
	`sha256` text NOT NULL,
	`rights_status_id` text,
	`rights_permits_publication` integer,
	`public_approved` integer DEFAULT false NOT NULL,
	`unavailable_at` text,
	PRIMARY KEY(`release_id`, `position`),
	CONSTRAINT "release_artifacts_kind_values" CHECK("release_artifacts"."kind" IN ('record', 'attachment', 'citation', 'package', 'provenance')),
	CONSTRAINT "release_artifacts_position" CHECK("release_artifacts"."position" >= 0 AND "release_artifacts"."position" < 2000),
	CONSTRAINT "release_artifacts_hash" CHECK(length("release_artifacts"."sha256") = 64),
	CONSTRAINT "release_artifacts_revision" CHECK(("release_artifacts"."kind" = 'attachment') = ("release_artifacts"."revision" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `release_artifacts_unit` ON `release_artifacts` (`release_id`,`kind`,`unit_id`);--> statement-breakpoint
CREATE INDEX `release_artifacts_target` ON `release_artifacts` (`unit_id`);--> statement-breakpoint
CREATE INDEX `release_artifacts_root` ON `release_artifacts` (`root_id`);--> statement-breakpoint
CREATE TABLE `research_releases` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`scope` text NOT NULL,
	`rationale` text NOT NULL,
	`licence_version` text NOT NULL,
	`state` text DEFAULT 'draft' NOT NULL,
	`snapshot_seq` integer NOT NULL,
	`snapshot_at` text NOT NULL,
	`rev` integer DEFAULT 1 NOT NULL,
	`contents_digest` text NOT NULL,
	`manifest_hash` text,
	`manifest_mac` text,
	`public_manifest_hash` text,
	`predecessor_id` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`sealed_by` text,
	`sealed_at` text,
	`published_by` text,
	`published_at` text,
	`withdrawn_by` text,
	`withdrawn_at` text,
	`updated_seq` integer NOT NULL,
	CONSTRAINT "research_releases_state_values" CHECK("research_releases"."state" IN ('draft', 'sealed', 'published', 'withdrawn')),
	CONSTRAINT "research_releases_sealed_shape" CHECK(("research_releases"."state" = 'draft') = ("research_releases"."manifest_hash" IS NULL AND "research_releases"."manifest_mac" IS NULL AND "research_releases"."public_manifest_hash" IS NULL AND "research_releases"."sealed_at" IS NULL AND "research_releases"."sealed_by" IS NULL)),
	CONSTRAINT "research_releases_digests" CHECK(("research_releases"."manifest_hash" IS NULL OR length("research_releases"."manifest_hash") = 64) AND ("research_releases"."public_manifest_hash" IS NULL OR length("research_releases"."public_manifest_hash") = 64) AND length("research_releases"."contents_digest") = 64),
	CONSTRAINT "research_releases_published_pair" CHECK(("research_releases"."published_at" IS NULL) = ("research_releases"."published_by" IS NULL) AND ("research_releases"."withdrawn_at" IS NULL) = ("research_releases"."withdrawn_by" IS NULL)),
	CONSTRAINT "research_releases_published_state" CHECK(("research_releases"."published_at" IS NULL OR "research_releases"."state" IN ('published', 'withdrawn')) AND ("research_releases"."withdrawn_at" IS NULL OR "research_releases"."state" = 'withdrawn'))
);
--> statement-breakpoint
CREATE INDEX `research_releases_state` ON `research_releases` (`state`);--> statement-breakpoint
CREATE UNIQUE INDEX `research_releases_predecessor` ON `research_releases` (`predecessor_id`) WHERE "research_releases"."predecessor_id" IS NOT NULL;--> statement-breakpoint
-- A sealed release never changes (R59.2): its identity, manifest, authentication and artifacts are fixed, and only its forward state and the
-- publication and withdrawal marks may be set, once each. A different set of contents is a new release.
CREATE TRIGGER `research_releases_frozen` BEFORE UPDATE ON `research_releases`
WHEN OLD.state <> 'draft' AND (NEW.id IS NOT OLD.id OR NEW.name IS NOT OLD.name OR NEW.scope IS NOT OLD.scope OR NEW.rationale IS NOT OLD.rationale OR NEW.licence_version IS NOT OLD.licence_version
  OR NEW.snapshot_seq IS NOT OLD.snapshot_seq OR NEW.snapshot_at IS NOT OLD.snapshot_at OR NEW.contents_digest IS NOT OLD.contents_digest OR NEW.manifest_hash IS NOT OLD.manifest_hash
  OR NEW.manifest_mac IS NOT OLD.manifest_mac OR NEW.public_manifest_hash IS NOT OLD.public_manifest_hash OR NEW.predecessor_id IS NOT OLD.predecessor_id OR NEW.created_by IS NOT OLD.created_by
  OR NEW.created_at IS NOT OLD.created_at OR NEW.sealed_by IS NOT OLD.sealed_by OR NEW.sealed_at IS NOT OLD.sealed_at
  OR (OLD.published_at IS NOT NULL AND (NEW.published_at IS NOT OLD.published_at OR NEW.published_by IS NOT OLD.published_by))
  OR (OLD.withdrawn_at IS NOT NULL AND (NEW.withdrawn_at IS NOT OLD.withdrawn_at OR NEW.withdrawn_by IS NOT OLD.withdrawn_by)))
BEGIN SELECT RAISE(ABORT, 'release_sealed'); END;
--> statement-breakpoint
CREATE TRIGGER `research_releases_forward` BEFORE UPDATE OF state ON `research_releases`
WHEN NEW.state <> OLD.state AND NOT ((OLD.state = 'draft' AND NEW.state = 'sealed') OR (OLD.state = 'sealed' AND NEW.state = 'published') OR (OLD.state = 'published' AND NEW.state = 'withdrawn'))
BEGIN SELECT RAISE(ABORT, 'release_state_order'); END;
--> statement-breakpoint
CREATE TRIGGER `research_releases_keep` BEFORE DELETE ON `research_releases`
WHEN OLD.state <> 'draft'
BEGIN SELECT RAISE(ABORT, 'release_sealed'); END;
--> statement-breakpoint
CREATE TRIGGER `release_artifacts_add` BEFORE INSERT ON `release_artifacts`
WHEN (SELECT state FROM research_releases WHERE id = NEW.release_id) IS NOT 'draft'
BEGIN SELECT RAISE(ABORT, 'release_sealed'); END;
--> statement-breakpoint
-- After sealing, a permanent deletion may mark an artifact unavailable, once; nothing else about it changes.
CREATE TRIGGER `release_artifacts_change` BEFORE UPDATE ON `release_artifacts`
WHEN (SELECT state FROM research_releases WHERE id = OLD.release_id) IS NOT 'draft' AND (OLD.unavailable_at IS NOT NULL OR NEW.release_id IS NOT OLD.release_id OR NEW.position IS NOT OLD.position
  OR NEW.kind IS NOT OLD.kind OR NEW.unit_id IS NOT OLD.unit_id OR NEW.root_id IS NOT OLD.root_id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.item_kind IS NOT OLD.item_kind
  OR NEW.identifier IS NOT OLD.identifier OR NEW.title IS NOT OLD.title OR NEW.revision IS NOT OLD.revision OR NEW.sha256 IS NOT OLD.sha256 OR NEW.rights_status_id IS NOT OLD.rights_status_id
  OR NEW.rights_permits_publication IS NOT OLD.rights_permits_publication OR NEW.public_approved IS NOT OLD.public_approved)
BEGIN SELECT RAISE(ABORT, 'release_sealed'); END;
--> statement-breakpoint
CREATE TRIGGER `release_artifacts_keep` BEFORE DELETE ON `release_artifacts`
WHEN (SELECT state FROM research_releases WHERE id = OLD.release_id) IS NOT 'draft'
BEGIN SELECT RAISE(ABORT, 'release_sealed'); END;
--> statement-breakpoint
CREATE TRIGGER `release_approvals_add` BEFORE INSERT ON `release_approvals`
WHEN (SELECT state FROM research_releases WHERE id = NEW.release_id) IS NOT 'draft'
BEGIN SELECT RAISE(ABORT, 'release_sealed'); END;
--> statement-breakpoint
CREATE TRIGGER `release_approvals_change` BEFORE UPDATE ON `release_approvals`
BEGIN SELECT RAISE(ABORT, 'release_approval_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `release_approvals_keep` BEFORE DELETE ON `release_approvals`
WHEN (SELECT state FROM research_releases WHERE id = OLD.release_id) IS NOT 'draft'
BEGIN SELECT RAISE(ABORT, 'release_sealed'); END;
