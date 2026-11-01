PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_dual_approvals` (
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
	CONSTRAINT "dual_approvals_action_values" CHECK("__new_dual_approvals"."action" IN ('hold_override', 'access_widen', 'consent_on_behalf')),
	CONSTRAINT "dual_approvals_state_values" CHECK("__new_dual_approvals"."state" IN ('open', 'approved', 'declined', 'withdrawn', 'lapsed')),
	CONSTRAINT "dual_approvals_effect_hash" CHECK(length("__new_dual_approvals"."effect_hash") = 64),
	CONSTRAINT "dual_approvals_dependency_hash" CHECK("__new_dual_approvals"."dependency_manifest_hash" IS NULL OR length("__new_dual_approvals"."dependency_manifest_hash") = 64),
	CONSTRAINT "dual_approvals_decided_pair" CHECK(("__new_dual_approvals"."state" = 'open') = ("__new_dual_approvals"."decided_by" IS NULL) AND ("__new_dual_approvals"."decided_by" IS NULL) = ("__new_dual_approvals"."decided_at" IS NULL)),
	CONSTRAINT "dual_approvals_distinct" CHECK("__new_dual_approvals"."decided_by" IS NULL OR "__new_dual_approvals"."state" = 'withdrawn' OR "__new_dual_approvals"."decided_by" <> "__new_dual_approvals"."proposed_by")
);
--> statement-breakpoint
INSERT INTO `__new_dual_approvals`("id", "action", "target_id", "root_id", "target_json", "effect_json", "effect_hash", "dependency_manifest_hash", "state", "proposed_by", "proposed_at", "proposal_reason", "decided_by", "decided_at", "decision_reason", "updated_seq", "actor_id") SELECT "id", "action", "target_id", "root_id", "target_json", "effect_json", "effect_hash", "dependency_manifest_hash", "state", "proposed_by", "proposed_at", "proposal_reason", "decided_by", "decided_at", "decision_reason", "updated_seq", "actor_id" FROM `dual_approvals`;--> statement-breakpoint
DROP TABLE `dual_approvals`;--> statement-breakpoint
ALTER TABLE `__new_dual_approvals` RENAME TO `dual_approvals`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `dual_approvals_open` ON `dual_approvals` (`state`,`proposed_at`);--> statement-breakpoint
CREATE INDEX `dual_approvals_target` ON `dual_approvals` (`target_id`,`proposed_at`);--> statement-breakpoint
CREATE INDEX `dual_approvals_root` ON `dual_approvals` (`root_id`);