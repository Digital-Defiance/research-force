PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`state` text NOT NULL,
	`requested_by` text,
	`params` text,
	`cursor` text,
	`progress` text,
	`report_key` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`finished_at` text,
	CONSTRAINT "jobs_type_values" CHECK("__new_jobs"."type" IN ('journal_import', 'bulk_import', 'public_export', 'internal_backup', 'restore', 'deletion', 'preview', 'upload_verify')),
	CONSTRAINT "jobs_state_values" CHECK("__new_jobs"."state" IN ('queued', 'running', 'paused', 'complete', 'incomplete', 'failed'))
);
--> statement-breakpoint
INSERT INTO `__new_jobs`("id", "type", "state", "requested_by", "params", "cursor", "progress", "report_key", "created_at", "updated_at", "finished_at") SELECT "id", "type", "state", "requested_by", "params", "cursor", "progress", "report_key", "created_at", "updated_at", "finished_at" FROM `jobs`;--> statement-breakpoint
DROP TABLE `jobs`;--> statement-breakpoint
ALTER TABLE `__new_jobs` RENAME TO `jobs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `jobs_state` ON `jobs` (`type`,`state`);--> statement-breakpoint
ALTER TABLE `uploads` ADD `hash_verified_at` text;--> statement-breakpoint
UPDATE `uploads` SET `hash_verified_at` = `completed_at` WHERE `completed_at` IS NOT NULL;
