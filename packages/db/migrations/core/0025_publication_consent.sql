CREATE TABLE `publication_consents` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_id` text NOT NULL,
	`root_id` text NOT NULL,
	`member_id` text NOT NULL,
	`values_json` text NOT NULL,
	`approved_view_hash` text NOT NULL,
	`approved_snapshot_version` integer NOT NULL,
	`dependency_manifest_hash` text NOT NULL,
	`source` text NOT NULL,
	`source_id` text NOT NULL,
	`given_at` text NOT NULL,
	`withdrawn_at` text,
	`used_at` text,
	`updated_seq` integer NOT NULL,
	`actor_id` text,
	CONSTRAINT "publication_consents_source_values" CHECK("publication_consents"."source" IN ('request', 'proposal', 'dual')),
	CONSTRAINT "publication_consents_view_hash" CHECK(length("publication_consents"."approved_view_hash") = 64),
	CONSTRAINT "publication_consents_dependency_hash" CHECK(length("publication_consents"."dependency_manifest_hash") = 64),
	CONSTRAINT "publication_consents_spent" CHECK("publication_consents"."withdrawn_at" IS NULL OR "publication_consents"."used_at" IS NULL)
);
--> statement-breakpoint
CREATE INDEX `publication_consents_unit` ON `publication_consents` (`unit_id`,`given_at`);--> statement-breakpoint
CREATE INDEX `publication_consents_member` ON `publication_consents` (`member_id`,`given_at`);--> statement-breakpoint
CREATE INDEX `publication_consents_root` ON `publication_consents` (`root_id`);--> statement-breakpoint
CREATE INDEX `publication_consents_source` ON `publication_consents` (`source_id`);--> statement-breakpoint
CREATE TABLE `confidentiality_holds` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_id` text NOT NULL,
	`root_id` text NOT NULL,
	`member_id` text NOT NULL,
	`note` text NOT NULL,
	`placed_at` text NOT NULL,
	`lifted_by` text,
	`lifted_at` text,
	`lift_note` text,
	`override_id` text,
	`updated_seq` integer NOT NULL,
	`actor_id` text,
	CONSTRAINT "confidentiality_holds_resolution" CHECK("confidentiality_holds"."lifted_at" IS NULL OR "confidentiality_holds"."override_id" IS NULL),
	CONSTRAINT "confidentiality_holds_lift_pair" CHECK(("confidentiality_holds"."lifted_by" IS NULL) = ("confidentiality_holds"."lifted_at" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `confidentiality_holds_active` ON `confidentiality_holds` (`unit_id`,`member_id`) WHERE "confidentiality_holds"."lifted_at" IS NULL AND "confidentiality_holds"."override_id" IS NULL;--> statement-breakpoint
CREATE INDEX `confidentiality_holds_unit` ON `confidentiality_holds` (`unit_id`);--> statement-breakpoint
CREATE INDEX `confidentiality_holds_root` ON `confidentiality_holds` (`root_id`);--> statement-breakpoint
CREATE INDEX `confidentiality_holds_member` ON `confidentiality_holds` (`member_id`,`placed_at`);--> statement-breakpoint
CREATE TABLE `dual_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`target_id` text NOT NULL,
	`root_id` text NOT NULL,
	`target_json` text NOT NULL,
	`effect_json` text NOT NULL,
	`effect_hash` text NOT NULL,
	`dependency_manifest_hash` text,
	`state` text DEFAULT 'open' NOT NULL,
	`proposed_by` text NOT NULL,
	`proposed_at` text NOT NULL,
	`proposal_reason` text NOT NULL,
	`decided_by` text,
	`decided_at` text,
	`decision_reason` text,
	`updated_seq` integer NOT NULL,
	`actor_id` text,
	CONSTRAINT "dual_approvals_action_values" CHECK("dual_approvals"."action" IN ('hold_override', 'access_widen', 'consent_on_behalf')),
	CONSTRAINT "dual_approvals_state_values" CHECK("dual_approvals"."state" IN ('open', 'approved', 'declined', 'withdrawn', 'lapsed')),
	CONSTRAINT "dual_approvals_effect_hash" CHECK(length("dual_approvals"."effect_hash") = 64),
	CONSTRAINT "dual_approvals_dependency_hash" CHECK("dual_approvals"."dependency_manifest_hash" IS NULL OR length("dual_approvals"."dependency_manifest_hash") = 64),
	CONSTRAINT "dual_approvals_decided_pair" CHECK(("dual_approvals"."state" = 'open') = ("dual_approvals"."decided_by" IS NULL) AND ("dual_approvals"."decided_by" IS NULL) = ("dual_approvals"."decided_at" IS NULL)),
	CONSTRAINT "dual_approvals_distinct" CHECK("dual_approvals"."decided_by" IS NULL OR "dual_approvals"."decided_by" <> "dual_approvals"."proposed_by")
);
--> statement-breakpoint
CREATE INDEX `dual_approvals_open` ON `dual_approvals` (`state`,`proposed_at`);--> statement-breakpoint
CREATE INDEX `dual_approvals_target` ON `dual_approvals` (`target_id`,`proposed_at`);--> statement-breakpoint
CREATE INDEX `dual_approvals_root` ON `dual_approvals` (`root_id`);--> statement-breakpoint
CREATE TABLE `_g_consent_valid` (
	`x` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `_g_hold_free` (
	`x` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `_g_dual_open` (
	`x` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `_g_dual_distinct` (
	`x` integer NOT NULL
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_review_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`target_id` text NOT NULL,
	`root_id` text,
	`requester_id` text NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	`state` text DEFAULT 'needs_review' NOT NULL,
	`reviewer_id` text,
	`reviewed_at` text,
	`review_note` text,
	`request_type` text DEFAULT 'review' NOT NULL,
	`is_publication_request` integer DEFAULT false NOT NULL,
	`proposal` text,
	`outcome` text,
	`applied` text,
	`rev` integer DEFAULT 1 NOT NULL,
	`updated_seq` integer NOT NULL,
	`actor_id` text,
	CONSTRAINT "review_requests_state_values" CHECK("__new_review_requests"."state" IN ('needs_review', 'reviewed')),
	CONSTRAINT "review_requests_type_values" CHECK("__new_review_requests"."request_type" IN ('review', 'publication_request', 'proposal')),
	CONSTRAINT "review_requests_outcome_values" CHECK("__new_review_requests"."outcome" IS NULL OR "__new_review_requests"."outcome" IN ('applied', 'declined', 'approved')),
	CONSTRAINT "review_requests_reviewed" CHECK(("__new_review_requests"."state" = 'reviewed') = ("__new_review_requests"."reviewed_at" IS NOT NULL AND "__new_review_requests"."reviewer_id" IS NOT NULL)),
	CONSTRAINT "review_requests_type_flag" CHECK(("__new_review_requests"."is_publication_request" = 1) = ("__new_review_requests"."request_type" = 'publication_request')),
	CONSTRAINT "review_requests_outcome_publication" CHECK("__new_review_requests"."outcome" IS NULL OR ("__new_review_requests"."state" = 'reviewed' AND (("__new_review_requests"."request_type" = 'publication_request' AND "__new_review_requests"."outcome" IN ('applied', 'declined')) OR ("__new_review_requests"."request_type" = 'proposal' AND "__new_review_requests"."outcome" IN ('approved', 'declined'))))),
	CONSTRAINT "review_requests_proposal" CHECK(("__new_review_requests"."request_type" IN ('publication_request', 'proposal')) = ("__new_review_requests"."proposal" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_review_requests`("id", "target_id", "root_id", "requester_id", "note", "created_at", "state", "reviewer_id", "reviewed_at", "review_note", "request_type", "is_publication_request", "proposal", "outcome", "applied", "rev", "updated_seq", "actor_id") SELECT "id", "target_id", "root_id", "requester_id", "note", "created_at", "state", "reviewer_id", "reviewed_at", "review_note", CASE WHEN "is_publication_request" = 1 THEN 'publication_request' ELSE 'review' END, "is_publication_request", "proposal", "outcome", "applied", "rev", "updated_seq", "actor_id" FROM `review_requests`;--> statement-breakpoint
DROP TABLE `review_requests`;--> statement-breakpoint
ALTER TABLE `__new_review_requests` RENAME TO `review_requests`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `review_requests_target` ON `review_requests` (`target_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `review_requests_root` ON `review_requests` (`root_id`);--> statement-breakpoint
CREATE INDEX `review_requests_open` ON `review_requests` (`state`,`created_at`);
