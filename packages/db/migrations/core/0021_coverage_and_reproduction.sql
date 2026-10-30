CREATE TABLE `compute_scope_entries` (
	`scope_id` text NOT NULL,
	`position` integer NOT NULL,
	`state` text NOT NULL,
	`region` text NOT NULL,
	PRIMARY KEY(`scope_id`, `position`),
	CONSTRAINT "compute_scope_entries_state_values" CHECK("compute_scope_entries"."state" IN ('attempted', 'completed', 'excluded', 'unknown')),
	CONSTRAINT "compute_scope_entries_position" CHECK("compute_scope_entries"."position" >= 0 AND "compute_scope_entries"."position" < 100)
);
--> statement-breakpoint
CREATE TABLE `compute_scopes` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`package_version` integer NOT NULL,
	`manifest_hash` text NOT NULL,
	`schema_id` text,
	`schema_version` integer,
	`generic_text` text,
	`assumptions` text DEFAULT '[]' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "compute_scopes_shape" CHECK(("compute_scopes"."schema_id" IS NULL) = ("compute_scopes"."schema_version" IS NULL) AND ("compute_scopes"."schema_id" IS NULL) = ("compute_scopes"."generic_text" IS NOT NULL)),
	CONSTRAINT "compute_scopes_hash" CHECK(length("compute_scopes"."manifest_hash") = 64)
);
--> statement-breakpoint
CREATE INDEX `compute_scopes_run` ON `compute_scopes` (`run_id`,`id`);--> statement-breakpoint
CREATE INDEX `compute_scopes_schema` ON `compute_scopes` (`schema_id`,`schema_version`);--> statement-breakpoint
CREATE TABLE `reproduction_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`package_version` integer NOT NULL,
	`attempt_run_id` text NOT NULL,
	`outcome` text NOT NULL,
	`differences` text DEFAULT '[]' NOT NULL,
	`evidence` text DEFAULT '[]' NOT NULL,
	`note` text,
	`recorded_by` text NOT NULL,
	`recorded_at` text NOT NULL,
	CONSTRAINT "reproduction_attempts_outcome_values" CHECK("reproduction_attempts"."outcome" IN ('reproduced', 'not_reproduced', 'inconclusive'))
);
--> statement-breakpoint
CREATE INDEX `reproduction_attempts_package` ON `reproduction_attempts` (`run_id`,`package_version`,`recorded_by`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `reproduction_attempts_attempt_run` ON `reproduction_attempts` (`attempt_run_id`);--> statement-breakpoint
CREATE TABLE `scope_schemas` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`version` integer NOT NULL,
	`description` text,
	`dimensions` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "scope_schemas_version" CHECK("scope_schemas"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scope_schemas_name_version` ON `scope_schemas` (`project_id`,`name`,`version`);--> statement-breakpoint
ALTER TABLE `compute_packages` ADD `missing_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- The ingredients a version lacks are counted once, so its state can follow later attempts (R56.2). Versions recorded as Incomplete lack at least one.
UPDATE `compute_packages` SET `missing_count` = 1 WHERE `reproducibility_state` = 'incomplete';--> statement-breakpoint
CREATE TRIGGER `compute_packages_missing_immutable` BEFORE UPDATE OF `missing_count` ON `compute_packages`
BEGIN SELECT RAISE(ABORT, 'compute_package_immutable'); END;--> statement-breakpoint
-- Schemas, scopes and attempts are added, never changed (R56.3, R56.5).
CREATE TRIGGER `scope_schemas_immutable` BEFORE UPDATE ON `scope_schemas`
BEGIN SELECT RAISE(ABORT, 'compute_scope_immutable'); END;--> statement-breakpoint
CREATE TRIGGER `compute_scopes_immutable` BEFORE UPDATE ON `compute_scopes`
BEGIN SELECT RAISE(ABORT, 'compute_scope_immutable'); END;--> statement-breakpoint
CREATE TRIGGER `compute_scope_entries_immutable` BEFORE UPDATE ON `compute_scope_entries`
BEGIN SELECT RAISE(ABORT, 'compute_scope_immutable'); END;--> statement-breakpoint
CREATE TRIGGER `reproduction_attempts_immutable` BEFORE UPDATE ON `reproduction_attempts`
BEGIN SELECT RAISE(ABORT, 'reproduction_attempt_immutable'); END;
