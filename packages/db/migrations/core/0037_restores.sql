-- Task 38.5: the requested-restore lifecycle and its quarantine/release bookkeeping (R36.4, R36.8, R36.9, R36.10,
-- R36.16). An Administrator records a `restores` row naming the backup package to recreate; the `restore` job drives
-- it through preflight -> bootstrap -> insert -> validate/quarantine -> derived stages, keeping the restored material
-- QUARANTINED (the Publisher paused) until an operator EXPLICITLY releases containment. These rows are
-- restore-mechanism bookkeeping about the package being applied, never snapshotted research rows, so the backup
-- inventory excludes this table (R60.1).
CREATE TABLE `restores` (
	`id` text PRIMARY KEY NOT NULL,
	`source_export_id` text NOT NULL,
	`requested_by` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`released_at` text,
	`released_by` text,
	`state` text DEFAULT 'running' NOT NULL,
	`report` text,
	CONSTRAINT "restores_state_values" CHECK("restores"."state" IN ('running', 'quarantined', 'released', 'incomplete', 'failed')),
	CONSTRAINT "restores_released_fields" CHECK(("restores"."released_at" IS NULL) = ("restores"."released_by" IS NULL)),
	CONSTRAINT "restores_released_state" CHECK("restores"."released_at" IS NULL OR "restores"."state" = 'released')
);
--> statement-breakpoint
CREATE INDEX `restores_started` ON `restores` (`started_at`);
