CREATE TABLE `public_views` (
	`unit_key` text NOT NULL,
	`valid_from` integer NOT NULL,
	`valid_from_at` text NOT NULL,
	`valid_to_at` text,
	`effective` text NOT NULL,
	`project_id` text NOT NULL,
	`root_key` text NOT NULL,
	`path` text,
	`view_json` text NOT NULL,
	`view_hash` text NOT NULL,
	PRIMARY KEY(`unit_key`, `valid_from`),
	CONSTRAINT "public_views_effective_values" CHECK("public_views"."effective" IN ('public', 'withheld'))
);
--> statement-breakpoint
CREATE INDEX `pv_current` ON `public_views` (`project_id`,`unit_key`) WHERE "public_views"."valid_to_at" IS NULL;--> statement-breakpoint
CREATE INDEX `pv_asof` ON `public_views` (`valid_from_at`,`valid_to_at`);--> statement-breakpoint
CREATE INDEX `pv_root` ON `public_views` (`root_key`) WHERE "public_views"."valid_to_at" IS NULL;--> statement-breakpoint
CREATE TABLE `publish_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` text,
	`finished_at` text,
	`seq_to` integer,
	`urgent` integer,
	`version_id` text,
	`verified_at` text
);
--> statement-breakpoint
CREATE TABLE `search_forward` (
	`doc_key` text PRIMARY KEY NOT NULL,
	`terms_hash` text NOT NULL,
	`terms` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `site_files` (
	`path` text PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`size` integer NOT NULL,
	`updated_at` text NOT NULL
);
