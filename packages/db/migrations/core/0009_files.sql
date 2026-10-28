CREATE TABLE `_g_upload_limit` (
	`x` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `_g_upload_ready` (
	`x` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `upload_parts` (
	`upload_id` text NOT NULL,
	`part_number` integer NOT NULL,
	`sha256` text NOT NULL,
	`size_bytes` integer NOT NULL,
	PRIMARY KEY(`upload_id`, `part_number`),
	CONSTRAINT "upload_parts_number" CHECK("upload_parts"."part_number" > 0),
	CONSTRAINT "upload_parts_size" CHECK("upload_parts"."size_bytes" > 0)
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text,
	`state` text DEFAULT 'uploading' NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`file_name` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`mode` text NOT NULL,
	`multipart_id` text,
	`created_at` text NOT NULL,
	`completed_at` text,
	`attached_at` text,
	CONSTRAINT "uploads_state_values" CHECK("__new_uploads"."state" IN ('uploading', 'complete', 'attached', 'deleting')),
	CONSTRAINT "uploads_owner_values" CHECK("__new_uploads"."owner_type" IN ('member', 'outside_session')),
	CONSTRAINT "uploads_mode_values" CHECK("__new_uploads"."mode" IN ('single', 'multipart')),
	CONSTRAINT "uploads_multipart_id" CHECK(("__new_uploads"."mode" = 'multipart') = ("__new_uploads"."multipart_id" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_uploads`("id", "group_id", "state", "owner_type", "owner_id", "r2_key", "file_name", "size_bytes", "sha256", "mode", "multipart_id", "created_at", "completed_at", "attached_at") SELECT "id", NULL, CASE WHEN "attached_at" IS NOT NULL THEN 'attached' WHEN "completed_at" IS NOT NULL THEN 'complete' ELSE 'uploading' END, "owner_type", "owner_id", "r2_key", "file_name", "size_bytes", "sha256", "mode", "multipart_id", "created_at", "completed_at", "attached_at" FROM `uploads`;--> statement-breakpoint
DROP TABLE `uploads`;--> statement-breakpoint
ALTER TABLE `__new_uploads` RENAME TO `uploads`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uploads_r2_key` ON `uploads` (`r2_key`);--> statement-breakpoint
CREATE INDEX `uploads_owner` ON `uploads` (`owner_type`,`owner_id`);--> statement-breakpoint
CREATE INDEX `uploads_group` ON `uploads` (`owner_id`,`group_id`);--> statement-breakpoint
CREATE INDEX `uploads_abandoned` ON `uploads` (`attached_at`,`created_at`);
