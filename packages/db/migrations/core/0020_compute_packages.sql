CREATE TABLE `compute_artifacts` (
	`run_id` text NOT NULL,
	`package_version` integer NOT NULL,
	`position` integer NOT NULL,
	`role` text NOT NULL,
	`ref_type` text NOT NULL,
	`unit_id` text,
	`uri` text,
	`name` text,
	`sha256` text,
	`size_bytes` integer,
	PRIMARY KEY(`run_id`, `package_version`, `position`),
	CONSTRAINT "compute_artifacts_role_values" CHECK("compute_artifacts"."role" IN ('input', 'output', 'checkpoint')),
	CONSTRAINT "compute_artifacts_type_values" CHECK("compute_artifacts"."ref_type" IN ('attachment', 'external')),
	CONSTRAINT "compute_artifacts_position" CHECK("compute_artifacts"."position" >= 0 AND "compute_artifacts"."position" < 1000),
	CONSTRAINT "compute_artifacts_shape" CHECK(("compute_artifacts"."ref_type" = 'attachment') = ("compute_artifacts"."unit_id" IS NOT NULL) AND ("compute_artifacts"."ref_type" = 'external') = ("compute_artifacts"."uri" IS NOT NULL) AND ("compute_artifacts"."ref_type" = 'external' OR "compute_artifacts"."sha256" IS NOT NULL)),
	CONSTRAINT "compute_artifacts_hash" CHECK("compute_artifacts"."sha256" IS NULL OR length("compute_artifacts"."sha256") = 64)
);
--> statement-breakpoint
CREATE INDEX `compute_artifacts_unit` ON `compute_artifacts` (`unit_id`);--> statement-breakpoint
CREATE TABLE `compute_configuration` (
	`run_id` text NOT NULL,
	`package_version` integer NOT NULL,
	`seq` integer NOT NULL,
	`chunk` text NOT NULL,
	PRIMARY KEY(`run_id`, `package_version`, `seq`),
	CONSTRAINT "compute_configuration_seq" CHECK("compute_configuration"."seq" >= 0 AND "compute_configuration"."seq" < 20)
);
--> statement-breakpoint
CREATE TABLE `compute_environment` (
	`run_id` text NOT NULL,
	`package_version` integer NOT NULL,
	`position` integer NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`run_id`, `package_version`, `position`),
	CONSTRAINT "compute_environment_kind_values" CHECK("compute_environment"."kind" IN ('toolchain', 'hardware', 'os', 'dependency', 'seed')),
	CONSTRAINT "compute_environment_position" CHECK("compute_environment"."position" >= 0 AND "compute_environment"."position" < 200)
);
--> statement-breakpoint
CREATE TABLE `compute_packages` (
	`run_id` text NOT NULL,
	`package_version` integer NOT NULL,
	`manifest_hash` text NOT NULL,
	`reproducibility_state` text NOT NULL,
	`repository` text,
	`code_commit` text,
	`code_release` text,
	`command` text,
	`entrypoint` text,
	`method_version` text,
	`uses_randomness` integer DEFAULT 0 NOT NULL,
	`configuration_sha256` text,
	`configuration_bytes` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`run_id`, `package_version`),
	CONSTRAINT "compute_packages_state_values" CHECK("compute_packages"."reproducibility_state" IN ('incomplete', 'specified', 'reproduced', 'disputed')),
	CONSTRAINT "compute_packages_version" CHECK("compute_packages"."package_version" >= 1),
	CONSTRAINT "compute_packages_hash_length" CHECK(length("compute_packages"."manifest_hash") = 64),
	CONSTRAINT "compute_packages_configuration" CHECK(("compute_packages"."configuration_sha256" IS NULL) = ("compute_packages"."configuration_bytes" = 0) AND "compute_packages"."configuration_bytes" >= 0 AND "compute_packages"."configuration_bytes" <= 262144 AND ("compute_packages"."configuration_sha256" IS NULL OR length("compute_packages"."configuration_sha256") = 64)),
	CONSTRAINT "compute_packages_randomness" CHECK("compute_packages"."uses_randomness" IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `compute_packages_hash` ON `compute_packages` (`manifest_hash`);--> statement-breakpoint
-- A package version is added, never changed; only its reproducibility state follows later attempts (R56.1, R56.2).
CREATE TRIGGER `compute_packages_immutable` BEFORE UPDATE OF `run_id`, `package_version`, `manifest_hash`, `repository`, `code_commit`, `code_release`, `command`, `entrypoint`, `method_version`, `uses_randomness`, `configuration_sha256`, `configuration_bytes`, `created_by`, `created_at` ON `compute_packages`
BEGIN SELECT RAISE(ABORT, 'compute_package_immutable'); END;--> statement-breakpoint
CREATE TRIGGER `compute_artifacts_immutable` BEFORE UPDATE ON `compute_artifacts`
BEGIN SELECT RAISE(ABORT, 'compute_package_immutable'); END;--> statement-breakpoint
CREATE TRIGGER `compute_configuration_immutable` BEFORE UPDATE ON `compute_configuration`
BEGIN SELECT RAISE(ABORT, 'compute_package_immutable'); END;--> statement-breakpoint
CREATE TRIGGER `compute_environment_immutable` BEFORE UPDATE ON `compute_environment`
BEGIN SELECT RAISE(ABORT, 'compute_package_immutable'); END;
