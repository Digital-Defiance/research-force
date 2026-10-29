CREATE TABLE `external_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`actor_id` text,
	`request_hash` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`provider_ref` text,
	`detail` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "external_operation_state" CHECK("external_operations"."state" IN ('pending','accepted','confirmed','failed','uncertain')),
	CONSTRAINT "external_operation_detail" CHECK("external_operations"."detail" IS NULL OR length(CAST("external_operations"."detail" AS BLOB)) <= 500)
);
--> statement-breakpoint
CREATE INDEX `external_operations_state` ON `external_operations` (`state`,`updated_at`);--> statement-breakpoint
CREATE TABLE `idempotency_results` (
	`actor_id` text NOT NULL,
	`op_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`method` text NOT NULL,
	`route` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`status` integer,
	`error_code` text,
	`resource_json` text,
	`created_at` text NOT NULL,
	`completed_at` text,
	PRIMARY KEY(`actor_id`, `op_key`),
	CONSTRAINT "idempotency_state" CHECK("idempotency_results"."state" IN ('pending','committed','refused')),
	CONSTRAINT "idempotency_resource_bytes" CHECK("idempotency_results"."resource_json" IS NULL OR length(CAST("idempotency_results"."resource_json" AS BLOB)) <= 2000)
);
--> statement-breakpoint
CREATE INDEX `idempotency_created` ON `idempotency_results` (`created_at`);