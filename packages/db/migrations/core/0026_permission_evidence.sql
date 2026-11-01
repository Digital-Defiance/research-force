CREATE TABLE `_g_evidence_covered` (
	`x` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `permission_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_id` text NOT NULL,
	`root_id` text NOT NULL,
	`party_id` text,
	`grantor_name` text NOT NULL,
	`claimed_authority` text NOT NULL,
	`source` text NOT NULL,
	`evidence_reference` text NOT NULL,
	`snapshot_hash` text NOT NULL,
	`naming` text NOT NULL,
	`label` text,
	`licence` text,
	`expires_at` text,
	`verified` integer DEFAULT false NOT NULL,
	`supersedes_id` text,
	`superseded_by_id` text,
	`recorded_by` text NOT NULL,
	`recorded_at` text NOT NULL,
	`reason` text,
	`updated_seq` integer NOT NULL,
	`actor_id` text,
	CONSTRAINT "permission_evidence_source_values" CHECK("permission_evidence"."source" IN ('emailed', 'letter', 'call', 'email', 'other')),
	CONSTRAINT "permission_evidence_naming_values" CHECK("permission_evidence"."naming" IN ('named', 'unnamed')),
	CONSTRAINT "permission_evidence_snapshot_hash" CHECK(length("permission_evidence"."snapshot_hash") = 64),
	CONSTRAINT "permission_evidence_label_naming" CHECK("permission_evidence"."label" IS NULL OR "permission_evidence"."naming" = 'named'),
	CONSTRAINT "permission_evidence_unverified_unnamed" CHECK("permission_evidence"."verified" = 1 OR "permission_evidence"."naming" = 'unnamed')
);
--> statement-breakpoint
CREATE INDEX `permission_evidence_unit` ON `permission_evidence` (`unit_id`,`recorded_at`);--> statement-breakpoint
CREATE INDEX `permission_evidence_root` ON `permission_evidence` (`root_id`);--> statement-breakpoint
CREATE INDEX `permission_evidence_party` ON `permission_evidence` (`party_id`);--> statement-breakpoint
CREATE INDEX `permission_evidence_supersedes` ON `permission_evidence` (`supersedes_id`);--> statement-breakpoint
CREATE TABLE `permission_evidence_items` (
	`evidence_id` text NOT NULL,
	`unit_id` text NOT NULL,
	`position` integer NOT NULL,
	`content_rev` integer NOT NULL,
	`file_hash` text,
	`file_size` integer,
	PRIMARY KEY(`evidence_id`, `position`),
	CONSTRAINT "permission_evidence_items_position_range" CHECK("permission_evidence_items"."position" >= 0 AND "permission_evidence_items"."position" < 50),
	CONSTRAINT "permission_evidence_items_content_rev" CHECK("permission_evidence_items"."content_rev" >= 1),
	CONSTRAINT "permission_evidence_items_file_pair" CHECK(("permission_evidence_items"."file_hash" IS NULL) = ("permission_evidence_items"."file_size" IS NULL)),
	CONSTRAINT "permission_evidence_items_file_hash" CHECK("permission_evidence_items"."file_hash" IS NULL OR length("permission_evidence_items"."file_hash") = 64),
	CONSTRAINT "permission_evidence_items_file_size" CHECK("permission_evidence_items"."file_size" IS NULL OR "permission_evidence_items"."file_size" >= 0)
);
--> statement-breakpoint
CREATE INDEX `permission_evidence_items_unit` ON `permission_evidence_items` (`unit_id`);--> statement-breakpoint
CREATE TABLE `permission_evidence_uses` (
	`evidence_id` text NOT NULL,
	`use` text NOT NULL,
	PRIMARY KEY(`evidence_id`, `use`),
	CONSTRAINT "permission_evidence_uses_values" CHECK("permission_evidence_uses"."use" IN ('publication', 'file_share'))
);
--> statement-breakpoint
CREATE TABLE `permission_evidence_withdrawals` (
	`evidence_id` text PRIMARY KEY NOT NULL,
	`withdrawn_at` text NOT NULL,
	`withdrawn_by` text,
	`reason` text,
	`updated_seq` integer NOT NULL,
	`actor_id` text
);
