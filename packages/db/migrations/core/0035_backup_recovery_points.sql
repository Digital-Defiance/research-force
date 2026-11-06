-- Task 58.2: the independent recovery points, their transfer/verification lifecycle, and the minimal authenticated
-- suppression ledger carried independently with each recovery point (R36.3, R36.7, R36.12, R36.13, R36.16). A
-- scheduled Internal_Backup only becomes a verified RPO point once its sealed package is copied OUTSIDE the production
-- account and that copy decrypts and re-validates independently.
CREATE TABLE `backup_points` (
	`export_id` text PRIMARY KEY NOT NULL,
	`slot_key` text NOT NULL,
	`snapshot_seq` integer,
	`started_at` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`copy_state` text DEFAULT 'none' NOT NULL,
	`copy_destination` text,
	`copied_at` text,
	`verified_at` text,
	`verify_fault` text,
	`created_at` text NOT NULL,
	CONSTRAINT "backup_points_state_values" CHECK("backup_points"."state" IN ('pending', 'complete', 'incomplete')),
	CONSTRAINT "backup_points_copy_state_values" CHECK("backup_points"."copy_state" IN ('none', 'transferred', 'offline_pending', 'offline_confirmed')),
	CONSTRAINT "backup_points_verified_requires_copy" CHECK("backup_points"."verified_at" IS NULL OR ("backup_points"."state" = 'complete' AND "backup_points"."copy_state" <> 'none'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `backup_points_slot` ON `backup_points` (`slot_key`);--> statement-breakpoint
CREATE INDEX `backup_points_verified` ON `backup_points` (`verified_at`);--> statement-breakpoint
CREATE TABLE `suppression_generations` (
	`id` text PRIMARY KEY NOT NULL,
	`backup_point_id` text NOT NULL,
	`suppressed_id` text NOT NULL,
	`generation` integer NOT NULL,
	`suppressed_at` text NOT NULL,
	`digest` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `suppression_generations_point_id` ON `suppression_generations` (`backup_point_id`,`suppressed_id`);--> statement-breakpoint
CREATE INDEX `suppression_generations_point` ON `suppression_generations` (`backup_point_id`,`generation`);--> statement-breakpoint
CREATE TABLE `backup_alert_state` (
	`only` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`signature` text,
	`at` text NOT NULL,
	CONSTRAINT "backup_alert_state_single" CHECK("backup_alert_state"."only" = 1)
);
