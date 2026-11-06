CREATE TABLE `write_freeze_leases` (
	`only` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`job_id` text NOT NULL,
	`generation` integer NOT NULL,
	`acquired_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`deadline_at` text NOT NULL,
	`heartbeat_at` text NOT NULL,
	`snapshot_seq` integer NOT NULL,
	`state` text DEFAULT 'held' NOT NULL,
	CONSTRAINT "write_freeze_leases_single" CHECK("write_freeze_leases"."only" = 1),
	CONSTRAINT "write_freeze_leases_state_values" CHECK("write_freeze_leases"."state" IN ('held', 'released', 'complete', 'incomplete'))
);
--> statement-breakpoint
CREATE TABLE `backup_file_pins` (
	`generation` integer NOT NULL,
	`r2_key` text NOT NULL,
	`state` text DEFAULT 'pinned' NOT NULL,
	`pinned_at` text NOT NULL,
	`released_at` text,
	CONSTRAINT "backup_file_pins_state_values" CHECK("backup_file_pins"."state" IN ('pinned', 'copied', 'invalidated'))
);
--> statement-breakpoint
CREATE INDEX `backup_file_pins_key` ON `backup_file_pins` (`generation`,`r2_key`);--> statement-breakpoint
CREATE INDEX `backup_file_pins_live` ON `backup_file_pins` (`r2_key`) WHERE "backup_file_pins"."state" = 'pinned';--> statement-breakpoint
CREATE TABLE `freeze_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`generation` integer NOT NULL,
	`action` text NOT NULL,
	`actor` text NOT NULL,
	`reason` text,
	`at` text NOT NULL,
	CONSTRAINT "freeze_audit_action_values" CHECK("freeze_audit"."action" IN ('acquire', 'renew', 'release', 'complete', 'incomplete', 'recover', 'invalidate')),
	CONSTRAINT "freeze_audit_reason" CHECK("freeze_audit"."action" NOT IN ('recover', 'incomplete') OR "freeze_audit"."reason" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `freeze_audit_generation` ON `freeze_audit` (`generation`,`at`);--> statement-breakpoint
-- The freeze generation counter; `acquireFreeze` bumps it so each acquisition takes a strictly greater generation (R36.14).
INSERT INTO `counters` (`k`, `v`) VALUES ('freeze_generation', 0);--> statement-breakpoint
-- The freeze audit is an append-only incident record; a row is never changed or removed (R36.14, R60.6).
CREATE TRIGGER `freeze_audit_immutable` BEFORE UPDATE ON `freeze_audit`
BEGIN SELECT RAISE(ABORT, 'freeze audit records are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `freeze_audit_permanent` BEFORE DELETE ON `freeze_audit`
BEGIN SELECT RAISE(ABORT, 'freeze audit records are permanent'); END;
