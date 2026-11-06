-- Task 58.4: the RESTORE-OWNED CHECKPOINTS that make a restore resumable without recreating any element twice (R36.4,
-- R36.10, R36.15). Before a quarantined restore installs a canonical row it records (restore_id, table, key,
-- payload_hash); on a resume or re-run it SKIPS only a row the SAME restore already installed with the SAME canonical
-- payload, and FAILS WITH A REPORT on any other conflict (a pre-existing different row, an unexpected duplicate, a
-- conflicting destination) — never an unconditional INSERT OR IGNORE. These rows are restore-mechanism bookkeeping,
-- never snapshotted research rows, so the backup inventory excludes this table (R60.1).
CREATE TABLE `restore_checkpoints` (
	`restore_id` text NOT NULL,
	`table_name` text NOT NULL,
	`row_key` text NOT NULL,
	`payload_hash` text NOT NULL,
	`installed_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `restore_checkpoints_row` ON `restore_checkpoints` (`restore_id`,`table_name`,`row_key`);--> statement-breakpoint
CREATE INDEX `restore_checkpoints_restore` ON `restore_checkpoints` (`restore_id`,`installed_at`);
