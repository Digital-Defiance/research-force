CREATE TABLE `evidence_citations` (
	`id` text PRIMARY KEY NOT NULL,
	`citing_unit_id` text NOT NULL,
	`citing_root_id` text NOT NULL,
	`citing_field` text NOT NULL,
	`target_type` text NOT NULL,
	`target_unit_id` text NOT NULL,
	`target_root_id` text NOT NULL,
	`target_field` text,
	`target_version_id` text,
	`target_rev` integer,
	`content_hash` text NOT NULL,
	`role` text NOT NULL,
	`locator_type` text NOT NULL,
	`locator_json` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`earlier_version_at` text,
	`retired_at` text,
	`retired_by` text,
	`replaced_by` text,
	`updated_seq` integer NOT NULL,
	`actor_id` text,
	CONSTRAINT "citations_target_values" CHECK("evidence_citations"."target_type" IN ('source', 'attachment', 'text')),
	CONSTRAINT "citations_role_values" CHECK("evidence_citations"."role" IN ('supports', 'contradicts', 'background', 'method')),
	CONSTRAINT "citations_locator_values" CHECK("evidence_citations"."locator_type" IN ('page', 'folio', 'section', 'text_range', 'image_region', 'unresolved')),
	CONSTRAINT "citations_text_target" CHECK(("evidence_citations"."target_type" = 'text') = ("evidence_citations"."target_field" IS NOT NULL)),
	CONSTRAINT "citations_target_rev" CHECK(("evidence_citations"."target_type" <> 'attachment') = ("evidence_citations"."target_rev" IS NOT NULL)),
	CONSTRAINT "citations_version_text_only" CHECK("evidence_citations"."target_version_id" IS NULL OR "evidence_citations"."target_type" = 'text'),
	CONSTRAINT "citations_hash" CHECK(length("evidence_citations"."content_hash") = 64),
	CONSTRAINT "citations_locator_bytes" CHECK(length(CAST("evidence_citations"."locator_json" AS BLOB)) <= 4000),
	CONSTRAINT "citations_retired_pair" CHECK(("evidence_citations"."retired_at" IS NULL) = ("evidence_citations"."retired_by" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `citations_citing_root` ON `evidence_citations` (`citing_root_id`);--> statement-breakpoint
CREATE INDEX `citations_citing_field` ON `evidence_citations` (`citing_unit_id`,`citing_field`);--> statement-breakpoint
CREATE INDEX `citations_target` ON `evidence_citations` (`target_unit_id`);--> statement-breakpoint
CREATE INDEX `citations_target_root` ON `evidence_citations` (`target_root_id`);--> statement-breakpoint
CREATE TABLE `source_bibliography` (
	`unit_id` text PRIMARY KEY NOT NULL,
	`publication_date` text,
	`publication_date_approx` integer DEFAULT false NOT NULL,
	`edition` text,
	`language` text,
	`external_url` text,
	`access_date` text
);
--> statement-breakpoint
CREATE TABLE `source_creators` (
	`unit_id` text NOT NULL,
	`position` integer NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`unit_id`, `position`),
	CONSTRAINT "source_creators_role_values" CHECK("source_creators"."role" IN ('author', 'editor', 'translator', 'compiler', 'addressee', 'photographer', 'issuer', 'other')),
	CONSTRAINT "source_creators_position_range" CHECK("source_creators"."position" >= 0 AND "source_creators"."position" < 50)
);
--> statement-breakpoint
CREATE TABLE `source_identifiers` (
	`unit_id` text NOT NULL,
	`position` integer NOT NULL,
	`scheme` text NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`unit_id`, `position`),
	CONSTRAINT "source_identifiers_scheme_values" CHECK("source_identifiers"."scheme" IN ('doi', 'isbn', 'issn', 'ark', 'handle', 'oclc', 'other')),
	CONSTRAINT "source_identifiers_position_range" CHECK("source_identifiers"."position" >= 0 AND "source_identifiers"."position" < 20)
);

--> statement-breakpoint
CREATE TRIGGER `evidence_citations_immutable` BEFORE UPDATE ON `evidence_citations`
WHEN NEW.id IS NOT OLD.id OR NEW.citing_unit_id IS NOT OLD.citing_unit_id OR NEW.citing_root_id IS NOT OLD.citing_root_id OR NEW.citing_field IS NOT OLD.citing_field
  OR NEW.target_type IS NOT OLD.target_type OR NEW.target_unit_id IS NOT OLD.target_unit_id OR NEW.target_root_id IS NOT OLD.target_root_id
  OR NEW.target_field IS NOT OLD.target_field OR NEW.target_version_id IS NOT OLD.target_version_id OR NEW.target_rev IS NOT OLD.target_rev
  OR NEW.content_hash IS NOT OLD.content_hash OR NEW.role IS NOT OLD.role OR NEW.locator_type IS NOT OLD.locator_type OR NEW.locator_json IS NOT OLD.locator_json
  OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.earlier_version_at IS NOT NULL AND NEW.earlier_version_at IS NOT OLD.earlier_version_at)
  OR (OLD.retired_at IS NOT NULL AND (NEW.retired_at IS NOT OLD.retired_at OR NEW.retired_by IS NOT OLD.retired_by OR NEW.replaced_by IS NOT OLD.replaced_by))
BEGIN SELECT RAISE(ABORT, 'citation_immutable'); END;
