CREATE TABLE `activity` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`actor_id` text NOT NULL,
	`kind` text NOT NULL,
	`submission_id` text,
	`target_type` text,
	`target_id` text,
	`refs` text,
	`counts` text,
	CONSTRAINT "activity_kind_values" CHECK("activity"."kind" IN ('submission', 'correction', 'withdrawal', 'status_change', 'disclosure_change', 'dissent', 'policy_change', 'journal_import')),
	CONSTRAINT "activity_target_values" CHECK("activity"."target_type" IS NULL OR "activity"."target_type" IN ('unit', 'project', 'policy_page'))
);
--> statement-breakpoint
CREATE INDEX `activity_actor` ON `activity` (`actor_id`,`id`);--> statement-breakpoint
CREATE INDEX `activity_submission` ON `activity` (`submission_id`);--> statement-breakpoint
CREATE TABLE `activity_tags` (
	`activity_id` text NOT NULL,
	`tag_type` text NOT NULL,
	`tag_value` text NOT NULL,
	PRIMARY KEY(`activity_id`, `tag_type`, `tag_value`),
	CONSTRAINT "activity_tags_type_values" CHECK("activity_tags"."tag_type" IN ('kind', 'project'))
);
--> statement-breakpoint
CREATE INDEX `activity_tags_filter` ON `activity_tags` (`tag_type`,`tag_value`,`activity_id`);--> statement-breakpoint
CREATE TABLE `email_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`group_key` text NOT NULL,
	`window_start` text NOT NULL,
	`window_minutes` integer NOT NULL,
	`window_end` text NOT NULL,
	`state` text NOT NULL,
	CONSTRAINT "email_batches_state_values" CHECK("email_batches"."state" IN ('open', 'queued', 'sent', 'failed')),
	CONSTRAINT "email_batches_window_range" CHECK("email_batches"."window_minutes" BETWEEN 1 AND 60)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `batch_open` ON `email_batches` (`member_id`,`group_key`) WHERE "email_batches"."state" = 'open';--> statement-breakpoint
CREATE INDEX `batch_due` ON `email_batches` (`state`,`window_end`);--> statement-breakpoint
CREATE TABLE `flags` (
	`member_id` text NOT NULL,
	`unit_id` text NOT NULL,
	`flag` text NOT NULL,
	`bucket` text NOT NULL,
	`set_at` text NOT NULL,
	PRIMARY KEY(`member_id`, `unit_id`),
	CONSTRAINT "flags_kind_values" CHECK("flags"."flag" IN ('new', 'updated'))
);
--> statement-breakpoint
CREATE INDEX `flags_badges` ON `flags` (`member_id`,`bucket`);--> statement-breakpoint
CREATE INDEX `flags_unit` ON `flags` (`unit_id`);--> statement-breakpoint
CREATE TABLE `notification_events` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`event_type` text NOT NULL,
	`at` text NOT NULL,
	`actor_id` text,
	`root_id` text,
	`submission_id` text,
	`outside_submission_id` text,
	`alert_key` text,
	`detail` text,
	`notification_id` text,
	`email_mode` text NOT NULL,
	`email_batch_id` text,
	`digest_sent_at` text,
	CONSTRAINT "events_type_values" CHECK("notification_events"."event_type" IN ('new_submission', 'item_update', 'reply', 'mention', 'review_requested', 'review_completed', 'outside_submission', 'reminder', 'system_alert', 'dissent')),
	CONSTRAINT "events_email_values" CHECK("notification_events"."email_mode" IN ('immediate', 'daily_digest', 'off'))
);
--> statement-breakpoint
CREATE INDEX `events_member` ON `notification_events` (`member_id`,`at`);--> statement-breakpoint
CREATE INDEX `events_digest` ON `notification_events` (`email_mode`,`digest_sent_at`,`member_id`);--> statement-breakpoint
CREATE INDEX `events_batch` ON `notification_events` (`email_batch_id`);--> statement-breakpoint
CREATE INDEX `events_notification` ON `notification_events` (`notification_id`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`created_at` text NOT NULL,
	`read_at` text,
	`group_key` text NOT NULL,
	`summary` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notifications_member` ON `notifications` (`member_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `notifications_unread` ON `notifications` (`member_id`) WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE TABLE `outgoing_emails` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`recipient` text NOT NULL,
	`member_id` text,
	`outside_submission_id` text,
	`payload_ref` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`sendable_at` text NOT NULL,
	`held_ms` integer DEFAULT 0 NOT NULL,
	`sent_at` text,
	`failed_at` text,
	`rev` integer DEFAULT 1 NOT NULL,
	`updated_seq` integer NOT NULL,
	`actor_id` text,
	CONSTRAINT "outgoing_emails_kind_values" CHECK("outgoing_emails"."kind" IN ('invitation', 'acknowledgement', 'more_information', 'decision')),
	CONSTRAINT "outgoing_emails_state_values" CHECK("outgoing_emails"."state" IN ('queued', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `outgoing_emails_state` ON `outgoing_emails` (`state`,`sendable_at`);--> statement-breakpoint
CREATE INDEX `outgoing_emails_member` ON `outgoing_emails` (`member_id`);--> statement-breakpoint
CREATE INDEX `outgoing_emails_outside` ON `outgoing_emails` (`outside_submission_id`);--> statement-breakpoint
CREATE TABLE `policy_pages` (
	`page_key` text PRIMARY KEY NOT NULL,
	`sections_changed_at` text,
	`rev` integer DEFAULT 1 NOT NULL,
	`updated_seq` integer NOT NULL,
	`actor_id` text,
	CONSTRAINT "policy_pages_key_values" CHECK("policy_pages"."page_key" IN ('about', 'people', 'methods', 'licence', 'privacy', 'corrections'))
);
--> statement-breakpoint
CREATE TABLE `policy_sections` (
	`page_key` text NOT NULL,
	`section_key` text NOT NULL,
	`position` integer NOT NULL,
	`title` text NOT NULL,
	`required` integer DEFAULT false NOT NULL,
	`text` text NOT NULL,
	`text_spans` text DEFAULT '[]' NOT NULL,
	`changed_at` text NOT NULL,
	PRIMARY KEY(`page_key`, `section_key`),
	CONSTRAINT "policy_sections_required_text" CHECK("policy_sections"."required" = 0 OR trim("policy_sections"."text", ' ' || char(9, 10, 13)) <> '')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `policy_sections_position` ON `policy_sections` (`page_key`,`position`);--> statement-breakpoint
CREATE TABLE `revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`root_id` text,
	`kind` text NOT NULL,
	`member_id` text NOT NULL,
	`at` text NOT NULL,
	`reason` text,
	`prev` text NOT NULL,
	`restored_point` text,
	`ai` text,
	`seq` integer NOT NULL,
	CONSTRAINT "revisions_target_values" CHECK("revisions"."target_type" IN ('unit', 'project', 'policy_page')),
	CONSTRAINT "revisions_kind_values" CHECK("revisions"."kind" IN ('minor_edit', 'correction', 'status_change', 'withdrawal', 'disclosure_change', 'restoration', 'deletion'))
);
--> statement-breakpoint
CREATE INDEX `rev_target` ON `revisions` (`target_type`,`target_id`,`at`);--> statement-breakpoint
CREATE INDEX `rev_root` ON `revisions` (`root_id`,`at`);--> statement-breakpoint
CREATE TABLE `submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`kind` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`counts` text,
	`outside_submission_id` text,
	`job_id` text,
	`has_group_note` integer DEFAULT false NOT NULL,
	CONSTRAINT "submissions_kind_values" CHECK("submissions"."kind" IN ('member', 'outside_acceptance', 'bulk_import', 'journal_import'))
);
--> statement-breakpoint
CREATE INDEX `submissions_member` ON `submissions` (`member_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `submissions_open` ON `submissions` (`completed_at`);--> statement-breakpoint
CREATE TABLE `views` (
	`member_id` text NOT NULL,
	`unit_id` text NOT NULL,
	`viewed_at` text NOT NULL,
	PRIMARY KEY(`member_id`, `unit_id`)
);
--> statement-breakpoint
CREATE INDEX `views_unit` ON `views` (`unit_id`);--> statement-breakpoint
CREATE TABLE `config_values` (
	`id` text PRIMARY KEY NOT NULL,
	`set_key` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`retired` integer DEFAULT false NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`permits_publication` integer,
	`position` integer NOT NULL,
	`public_description` text,
	`rev` integer DEFAULT 1 NOT NULL,
	`updated_seq` integer NOT NULL,
	`actor_id` text,
	CONSTRAINT "config_values_set_values" CHECK("config_values"."set_key" IN ('specialty', 'campaign_status', 'finding_status', 'run_outcome', 'hypothesis_status', 'archival_request_status', 'reliability', 'rights_status', 'relation')),
	CONSTRAINT "config_values_publication_rights_only" CHECK(("config_values"."permits_publication" IS NOT NULL) = ("config_values"."set_key" = 'rights_status')),
	CONSTRAINT "config_values_methods_description" CHECK("config_values"."set_key" = 'specialty' OR "config_values"."public_description" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `config_values_name_key` ON `config_values` (`set_key`,`name_key`);--> statement-breakpoint
CREATE INDEX `config_values_set` ON `config_values` (`set_key`,`position`);--> statement-breakpoint
CREATE TABLE `counters` (
	`k` text PRIMARY KEY NOT NULL,
	`v` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`email_lc` text NOT NULL,
	`role_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`invited_by` text,
	`activated_at` text,
	`revoked_at` text,
	`invite_email_state` text,
	`rev` integer DEFAULT 1 NOT NULL,
	`updated_seq` integer NOT NULL,
	`actor_id` text,
	CONSTRAINT "members_status_values" CHECK("members"."status" IN ('pending', 'active', 'revoked')),
	CONSTRAINT "members_invite_email_values" CHECK("members"."invite_email_state" IS NULL OR "members"."invite_email_state" IN ('pending', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `members_email_lc` ON `members` (`email_lc`);--> statement-breakpoint
CREATE INDEX `members_status` ON `members` (`status`,`role_id`);--> statement-breakpoint
CREATE TABLE `methods_terms` (
	`key` text PRIMARY KEY NOT NULL,
	`group_key` text NOT NULL,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`public_description` text NOT NULL,
	`rev` integer DEFAULT 1 NOT NULL,
	`updated_seq` integer NOT NULL,
	`actor_id` text,
	CONSTRAINT "methods_terms_group_values" CHECK("methods_terms"."group_key" IN ('source_kind', 'disclosure_level', 'label_kind', 'term'))
);
--> statement-breakpoint
CREATE TABLE `muted_projects` (
	`member_id` text NOT NULL,
	`project_id` text NOT NULL,
	`muted_at` text NOT NULL,
	PRIMARY KEY(`member_id`, `project_id`)
);
--> statement-breakpoint
CREATE INDEX `muted_projects_project` ON `muted_projects` (`project_id`);--> statement-breakpoint
CREATE TABLE `notification_prefs` (
	`member_id` text NOT NULL,
	`event_type` text NOT NULL,
	`in_app` integer DEFAULT true NOT NULL,
	`email` text DEFAULT 'immediate' NOT NULL,
	PRIMARY KEY(`member_id`, `event_type`),
	CONSTRAINT "notification_prefs_event_values" CHECK("notification_prefs"."event_type" IN ('new_submission', 'item_update', 'reply', 'mention', 'review_requested', 'review_completed', 'outside_submission', 'reminder', 'system_alert', 'dissent')),
	CONSTRAINT "notification_prefs_email_values" CHECK("notification_prefs"."email" IN ('immediate', 'daily_digest', 'off'))
);
--> statement-breakpoint
CREATE TABLE `profile_affiliations` (
	`member_id` text NOT NULL,
	`position` integer NOT NULL,
	`text` text NOT NULL,
	PRIMARY KEY(`member_id`, `position`),
	CONSTRAINT "profile_affiliations_position_range" CHECK("profile_affiliations"."position" BETWEEN 0 AND 4)
);
--> statement-breakpoint
CREATE TABLE `profile_specialties` (
	`member_id` text NOT NULL,
	`value_id` text NOT NULL,
	PRIMARY KEY(`member_id`, `value_id`)
);
--> statement-breakpoint
CREATE INDEX `profile_specialties_value` ON `profile_specialties` (`value_id`);--> statement-breakpoint
CREATE TABLE `profiles` (
	`member_id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`display_name_key` text NOT NULL,
	`bio` text DEFAULT '' NOT NULL,
	`time_zone` text NOT NULL,
	`digest_hour` integer DEFAULT 8 NOT NULL,
	`public_profile` integer DEFAULT false NOT NULL,
	`licence_name` text,
	`licence_given_on` text,
	`rev` integer DEFAULT 1 NOT NULL,
	`updated_seq` integer NOT NULL,
	`actor_id` text,
	CONSTRAINT "profiles_digest_hour_range" CHECK("profiles"."digest_hour" BETWEEN 0 AND 23),
	CONSTRAINT "profiles_licence_pair" CHECK(("profiles"."licence_name" IS NULL) = ("profiles"."licence_given_on" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profiles_display_name_key` ON `profiles` (`display_name_key`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`short_description` text NOT NULL,
	`slug` text NOT NULL,
	`slug_fixed_at` text,
	`featured` integer DEFAULT false NOT NULL,
	`position` integer NOT NULL,
	`accent` text,
	`disclosure_level` text DEFAULT 'private' NOT NULL,
	`disclosure_line` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`rev` integer DEFAULT 1 NOT NULL,
	`updated_seq` integer NOT NULL,
	`actor_id` text,
	CONSTRAINT "projects_level_values" CHECK("projects"."disclosure_level" IN ('public', 'withheld', 'private')),
	CONSTRAINT "projects_withheld_line" CHECK("projects"."disclosure_level" <> 'withheld' OR "projects"."disclosure_line" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_name_key` ON `projects` (`name_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug` ON `projects` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_position` ON `projects` (`position`);--> statement-breakpoint
CREATE INDEX `projects_seq` ON `projects` (`updated_seq`);--> statement-breakpoint
CREATE TABLE `role_permissions` (
	`role_id` text NOT NULL,
	`permission` text NOT NULL,
	`scope` text NOT NULL,
	PRIMARY KEY(`role_id`, `permission`),
	CONSTRAINT "role_permissions_permission_values" CHECK("role_permissions"."permission" IN ('item.create', 'attachment.upload', 'reply.post', 'topic.create', 'item.edit', 'item.correct', 'item.withdraw', 'section.edit', 'logSummary.write', 'item.delete', 'link.add', 'link.remove', 'review.request', 'review.complete', 'party.doNotName.on', 'party.doNotName.off', 'profile.edit', 'dissent.attach', 'dissent.edit', 'dissent.withdraw', 'dissent.delete', 'ai.draft.logSummary', 'ai.draft.publicSummary', 'ai.draft.disclosureLine', 'disclosure.set', 'project.create', 'project.edit', 'item.move', 'moderation.decide', 'member.invite', 'member.role', 'member.revoke', 'role.add', 'role.edit', 'valueSet.manage', 'rights.markPublication', 'methods.describe', 'policy.edit', 'settings.edit', 'import.run', 'export.manage', 'backup.manage')),
	CONSTRAINT "role_permissions_scope_values" CHECK("role_permissions"."scope" IN ('any', 'own', 'other', 'eligible'))
);
--> statement-breakpoint
CREATE TABLE `roles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`builtin` integer DEFAULT false NOT NULL,
	`rev` integer DEFAULT 1 NOT NULL,
	`updated_seq` integer NOT NULL,
	`actor_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `roles_name_key` ON `roles` (`name_key`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`established_at` text NOT NULL,
	`ended_at` text
);
--> statement-breakpoint
CREATE INDEX `sessions_member` ON `sessions` (`member_id`);--> statement-breakpoint
CREATE INDEX `sessions_established` ON `sessions` (`established_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_by` text,
	`updated_at` text NOT NULL,
	`updated_seq` integer NOT NULL,
	`actor_id` text
);
--> statement-breakpoint
CREATE TABLE `archival_requests` (
	`unit_id` text PRIMARY KEY NOT NULL,
	`archive_kind` text NOT NULL,
	`archive_id` text NOT NULL,
	`contact_kind` text,
	`contact_id` text,
	`channel` text,
	`request_text` text NOT NULL,
	`request_text_spans` text DEFAULT '[]' NOT NULL,
	`date_sent` text,
	`date_sent_approx` integer DEFAULT false NOT NULL,
	`reply_date` text,
	`reply_date_approx` integer DEFAULT false NOT NULL,
	`reply_content` text,
	`reply_content_spans` text DEFAULT '[]' NOT NULL,
	`follow_up_reminded_at` text,
	CONSTRAINT "archival_requests_archive_values" CHECK("archival_requests"."archive_kind" IN ('member', 'external')),
	CONSTRAINT "archival_requests_contact_values" CHECK("archival_requests"."contact_kind" IS NULL OR "archival_requests"."contact_kind" IN ('member', 'external')),
	CONSTRAINT "archival_requests_contact_pair" CHECK(("archival_requests"."contact_kind" IS NULL) = ("archival_requests"."contact_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `archival_requests_archive` ON `archival_requests` (`archive_id`);--> statement-breakpoint
CREATE INDEX `archival_requests_contact` ON `archival_requests` (`contact_id`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`unit_id` text PRIMARY KEY NOT NULL,
	`item_identifier` text NOT NULL,
	`title` text NOT NULL,
	`file_kind` text NOT NULL,
	`original_name` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`size_label` text,
	`sha256` text NOT NULL,
	`r2_key` text NOT NULL,
	`caption` text,
	`origin` text NOT NULL,
	`uploaded_at` text NOT NULL,
	`rights_status_id` text NOT NULL,
	`rights_holder` text,
	`rights_terms` text,
	`chain_id` text NOT NULL,
	`supersedes_unit_id` text,
	CONSTRAINT "attachments_kind_values" CHECK("attachments"."file_kind" IN ('pdf', 'image', 'archive', 'spreadsheet', 'csv', 'structured_data', 'text_log', 'video', 'other')),
	CONSTRAINT "attachments_size" CHECK("attachments"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_identifier` ON `attachments` (`item_identifier`);--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_supersedes` ON `attachments` (`supersedes_unit_id`);--> statement-breakpoint
CREATE INDEX `attachments_chain` ON `attachments` (`chain_id`);--> statement-breakpoint
CREATE INDEX `attachments_rights` ON `attachments` (`rights_status_id`);--> statement-breakpoint
CREATE TABLE `correspondence_parties` (
	`unit_id` text NOT NULL,
	`position` integer NOT NULL,
	`party_kind` text NOT NULL,
	`party_id` text NOT NULL,
	`consent_status` text,
	PRIMARY KEY(`unit_id`, `position`),
	CONSTRAINT "correspondence_parties_kind_values" CHECK("correspondence_parties"."party_kind" IN ('member', 'external')),
	CONSTRAINT "correspondence_parties_consent_values" CHECK("correspondence_parties"."consent_status" IS NULL OR "correspondence_parties"."consent_status" IN ('not_asked', 'requested', 'granted', 'refused')),
	CONSTRAINT "correspondence_parties_consent_external" CHECK(("correspondence_parties"."consent_status" IS NOT NULL) = ("correspondence_parties"."party_kind" = 'external'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `correspondence_parties_party` ON `correspondence_parties` (`unit_id`,`party_kind`,`party_id`);--> statement-breakpoint
CREATE INDEX `correspondence_parties_by_party` ON `correspondence_parties` (`party_id`);--> statement-breakpoint
CREATE TABLE `correspondences` (
	`unit_id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`date_approx` integer DEFAULT false NOT NULL,
	`channel` text DEFAULT '' NOT NULL,
	`direction` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`content_spans` text DEFAULT '[]' NOT NULL,
	CONSTRAINT "correspondences_direction_values" CHECK("correspondences"."direction" IN ('sent', 'received'))
);
--> statement-breakpoint
CREATE TABLE `cross_links` (
	`id` text PRIMARY KEY NOT NULL,
	`origin_id` text NOT NULL,
	`target_id` text NOT NULL,
	`relation_value_id` text,
	`added_by` text NOT NULL,
	`added_at` text NOT NULL,
	`removed_by` text,
	`removed_at` text,
	CONSTRAINT "cross_links_not_self" CHECK("cross_links"."origin_id" <> "cross_links"."target_id"),
	CONSTRAINT "cross_links_removal_pair" CHECK(("cross_links"."removed_at" IS NULL) = ("cross_links"."removed_by" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `cross_links_target` ON `cross_links` (`target_id`);--> statement-breakpoint
CREATE INDEX `cross_links_origin` ON `cross_links` (`origin_id`);--> statement-breakpoint
CREATE TABLE `deletions` (
	`unit_id` text PRIMARY KEY NOT NULL,
	`unit_type` text NOT NULL,
	`kind` text,
	`item_identifier` text,
	`root_id` text NOT NULL,
	`project_id` text NOT NULL,
	`deleted_by` text NOT NULL,
	`deleted_at` text NOT NULL,
	`reason` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `deletions_root` ON `deletions` (`root_id`);--> statement-breakpoint
CREATE INDEX `deletions_project` ON `deletions` (`project_id`,`deleted_at`);--> statement-breakpoint
CREATE TABLE `dissent_notes` (
	`unit_id` text PRIMARY KEY NOT NULL,
	`author_id` text NOT NULL,
	`text` text NOT NULL,
	`text_spans` text DEFAULT '[]' NOT NULL,
	`attached_at` text NOT NULL,
	`last_saved_at` text NOT NULL,
	`concerned_summary` text NOT NULL,
	`concerned_summary_spans` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `dissent_notes_author` ON `dissent_notes` (`author_id`);--> statement-breakpoint
CREATE TABLE `entry_sections` (
	`unit_id` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`text_spans` text DEFAULT '[]' NOT NULL,
	`sep_before` text,
	`group_kind` text,
	`group_id` integer,
	`src_line_start` integer,
	`src_line_end` integer,
	`unassigned` integer DEFAULT false NOT NULL,
	CONSTRAINT "entry_sections_group_values" CHECK("entry_sections"."group_kind" IS NULL OR "entry_sections"."group_kind" IN ('list', 'table')),
	CONSTRAINT "entry_sections_group_pair" CHECK(("entry_sections"."group_kind" IS NULL) = ("entry_sections"."group_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE `external_parties` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_fold` text NOT NULL,
	`do_not_name` integer DEFAULT false NOT NULL,
	`generic_label` text,
	`created_at` text NOT NULL,
	`rev` integer DEFAULT 1 NOT NULL,
	`updated_seq` integer NOT NULL,
	`actor_id` text,
	CONSTRAINT "external_parties_label" CHECK("external_parties"."do_not_name" = 0 OR "external_parties"."generic_label" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `external_parties_fold` ON `external_parties` (`name_fold`);--> statement-breakpoint
CREATE TABLE `findings` (
	`unit_id` text PRIMARY KEY NOT NULL,
	`claim` text NOT NULL,
	`claim_spans` text DEFAULT '[]' NOT NULL,
	`scope_caveat` text NOT NULL,
	`scope_caveat_spans` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `hypotheses` (
	`unit_id` text PRIMARY KEY NOT NULL,
	`statement` text NOT NULL,
	`statement_spans` text DEFAULT '[]' NOT NULL,
	`elimination_scope` text,
	`elimination_scope_spans` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `identifiers` (
	`identifier_lc` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`unit_id` text NOT NULL,
	`issued_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `identifiers_unit` ON `identifiers` (`unit_id`);--> statement-breakpoint
CREATE TABLE `je_members` (
	`unit_id` text NOT NULL,
	`member_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`unit_id`, `member_id`)
);
--> statement-breakpoint
CREATE INDEX `je_members_member` ON `je_members` (`member_id`);--> statement-breakpoint
CREATE TABLE `journal_entries` (
	`unit_id` text PRIMARY KEY NOT NULL,
	`phase_id` text,
	`heading_text` text,
	`heading_raw` text,
	`start_date` text,
	`start_date_approx` integer DEFAULT false NOT NULL,
	`end_date` text,
	`end_date_approx` integer DEFAULT false NOT NULL,
	`trailing` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `replies` (
	`unit_id` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`text_spans` text DEFAULT '[]' NOT NULL,
	`is_group_note` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `research_items` (
	`unit_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`item_identifier` text NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`status_value_id` text,
	`item_date_key` text NOT NULL,
	`log_date_key` text NOT NULL,
	`log_date_is_creation` integer DEFAULT false NOT NULL,
	`log_summary` text,
	`log_summary_spans` text DEFAULT '[]' NOT NULL,
	`public_summary` text,
	`public_summary_spans` text DEFAULT '[]' NOT NULL,
	`public_presentation` text DEFAULT 'summary_only' NOT NULL,
	`first_public_at` text,
	`import_key` text,
	`import_row_key` text,
	CONSTRAINT "research_items_kind_values" CHECK("research_items"."kind" IN ('journal_entry', 'finding', 'source', 'run', 'hypothesis', 'correspondence', 'archival_request', 'topic')),
	CONSTRAINT "research_items_presentation_values" CHECK("research_items"."public_presentation" IN ('summary_only', 'full_content'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `research_items_identifier` ON `research_items` (`item_identifier`);--> statement-breakpoint
CREATE UNIQUE INDEX `research_items_import_row_key` ON `research_items` (`import_row_key`) WHERE "research_items"."import_row_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `research_items_log` ON `research_items` (`project_id`,`log_date_key`);--> statement-breakpoint
CREATE INDEX `research_items_kind` ON `research_items` (`kind`,`project_id`);--> statement-breakpoint
CREATE INDEX `research_items_import_key` ON `research_items` (`project_id`,`import_key`);--> statement-breakpoint
CREATE TABLE `review_addressees` (
	`request_id` text NOT NULL,
	`addressee_type` text NOT NULL,
	`addressee_id` text NOT NULL,
	PRIMARY KEY(`request_id`, `addressee_type`, `addressee_id`),
	CONSTRAINT "review_addressees_type_values" CHECK("review_addressees"."addressee_type" IN ('member', 'specialty', 'role'))
);
--> statement-breakpoint
CREATE INDEX `review_addressees_by` ON `review_addressees` (`addressee_type`,`addressee_id`);--> statement-breakpoint
CREATE TABLE `review_requests` (
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
	`is_publication_request` integer DEFAULT false NOT NULL,
	`proposal` text,
	`outcome` text,
	`applied` text,
	`rev` integer DEFAULT 1 NOT NULL,
	`updated_seq` integer NOT NULL,
	`actor_id` text,
	CONSTRAINT "review_requests_state_values" CHECK("review_requests"."state" IN ('needs_review', 'reviewed')),
	CONSTRAINT "review_requests_outcome_values" CHECK("review_requests"."outcome" IS NULL OR "review_requests"."outcome" IN ('applied', 'declined')),
	CONSTRAINT "review_requests_reviewed" CHECK(("review_requests"."state" = 'reviewed') = ("review_requests"."reviewed_at" IS NOT NULL AND "review_requests"."reviewer_id" IS NOT NULL)),
	CONSTRAINT "review_requests_outcome_publication" CHECK("review_requests"."outcome" IS NULL OR ("review_requests"."is_publication_request" = 1 AND "review_requests"."state" = 'reviewed')),
	CONSTRAINT "review_requests_proposal" CHECK(("review_requests"."is_publication_request" = 1) = ("review_requests"."proposal" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `review_requests_target` ON `review_requests` (`target_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `review_requests_root` ON `review_requests` (`root_id`);--> statement-breakpoint
CREATE INDEX `review_requests_open` ON `review_requests` (`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `run_counts` (
	`unit_id` text NOT NULL,
	`position` integer NOT NULL,
	`name` text NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`unit_id`, `position`),
	CONSTRAINT "run_counts_digits" CHECK(typeof("run_counts"."value") = 'text' AND length("run_counts"."value") BETWEEN 1 AND 30 AND "run_counts"."value" NOT GLOB '*[^0-9]*'),
	CONSTRAINT "run_counts_position_range" CHECK("run_counts"."position" BETWEEN 0 AND 19)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_counts_name` ON `run_counts` (`unit_id`,`name`);--> statement-breakpoint
CREATE TABLE `runs` (
	`unit_id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`scope_spans` text DEFAULT '[]' NOT NULL,
	`parameters` text NOT NULL,
	`parameters_spans` text DEFAULT '[]' NOT NULL,
	`tool_name` text NOT NULL,
	`tool_version` text NOT NULL,
	`compute_resource` text NOT NULL,
	`start_time` text NOT NULL,
	`start_key` text NOT NULL,
	`end_time` text,
	`outcome_id` text NOT NULL,
	`resume_point` text,
	`notes` text,
	`notes_spans` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sources` (
	`unit_id` text PRIMARY KEY NOT NULL,
	`source_kind` text NOT NULL,
	`reliability_id` text NOT NULL,
	`doc_date` text,
	`doc_date_approx` integer DEFAULT false NOT NULL,
	`doc_date_end` text,
	`doc_date_end_approx` integer DEFAULT false NOT NULL,
	`archive_or_collection` text,
	`archival_reference` text,
	`recoverer_kind` text,
	`recoverer_id` text,
	`reliability_note` text,
	`reliability_note_spans` text DEFAULT '[]' NOT NULL,
	`rights_status_id` text NOT NULL,
	`rights_holder` text,
	`rights_terms` text,
	CONSTRAINT "sources_kind_values" CHECK("sources"."source_kind" IN ('primary', 'secondary')),
	CONSTRAINT "sources_recoverer_values" CHECK("sources"."recoverer_kind" IS NULL OR "sources"."recoverer_kind" IN ('member', 'external')),
	CONSTRAINT "sources_recoverer_pair" CHECK(("sources"."recoverer_kind" IS NULL) = ("sources"."recoverer_id" IS NULL)),
	CONSTRAINT "sources_range_start" CHECK("sources"."doc_date_end" IS NULL OR "sources"."doc_date" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `sources_recoverer` ON `sources` (`recoverer_id`);--> statement-breakpoint
CREATE TABLE `topics` (
	`unit_id` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	`body_spans` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `units` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_type` text NOT NULL,
	`project_id` text NOT NULL,
	`root_id` text NOT NULL,
	`parent_id` text,
	`position` integer DEFAULT 0 NOT NULL,
	`owner_id` text NOT NULL,
	`credit` text NOT NULL,
	`submission_id` text NOT NULL,
	`created_at` text NOT NULL,
	`created_ai` text,
	`disclosure_level` text DEFAULT 'private' NOT NULL,
	`classification_state` text,
	`classified_by` text,
	`classified_at` text,
	`disclosure_line` text,
	`withdrawn_at` text,
	`withdrawn_by` text,
	`withdrawal_reason` text,
	`rev` integer DEFAULT 1 NOT NULL,
	`updated_seq` integer NOT NULL,
	`actor_id` text,
	CONSTRAINT "units_type_values" CHECK("units"."unit_type" IN ('research_item', 'entry_section', 'attachment', 'reply', 'dissent_note')),
	CONSTRAINT "units_level_values" CHECK("units"."disclosure_level" IN ('public', 'withheld', 'private')),
	CONSTRAINT "units_classification_values" CHECK("units"."classification_state" IS NULL OR "units"."classification_state" IN ('unclassified', 'classified')),
	CONSTRAINT "units_withheld_line" CHECK("units"."disclosure_level" <> 'withheld' OR "units"."disclosure_line" IS NOT NULL),
	CONSTRAINT "units_unclassified_private" CHECK("units"."classification_state" IS NOT 'unclassified' OR "units"."disclosure_level" = 'private'),
	CONSTRAINT "units_root_shape" CHECK(("units"."unit_type" = 'research_item') = ("units"."root_id" = "units"."id" AND "units"."parent_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `units_root` ON `units` (`root_id`,`unit_type`);--> statement-breakpoint
CREATE INDEX `units_parent` ON `units` (`parent_id`,`position`);--> statement-breakpoint
CREATE INDEX `units_project` ON `units` (`project_id`,`unit_type`);--> statement-breakpoint
CREATE INDEX `units_submission` ON `units` (`submission_id`);--> statement-breakpoint
CREATE INDEX `units_seq` ON `units` (`updated_seq`);--> statement-breakpoint
CREATE INDEX `units_unclassified` ON `units` (`classification_state`,`root_id`);--> statement-breakpoint
CREATE TABLE `exports` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`scope_project_id` text,
	`scheduled` integer DEFAULT false NOT NULL,
	`requested_by` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	`state` text NOT NULL,
	`incomplete` text,
	`volumes` text,
	`unit_index_key` text,
	`staleness` text,
	`delivered_at` text,
	`expires_at` text,
	CONSTRAINT "exports_type_values" CHECK("exports"."type" IN ('public', 'backup')),
	CONSTRAINT "exports_state_values" CHECK("exports"."state" IN ('running', 'complete', 'incomplete', 'deleted')),
	CONSTRAINT "exports_backup_unscheduled" CHECK("exports"."type" = 'public' OR ("exports"."scheduled" = 0 AND "exports"."scope_project_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `exports_type` ON `exports` (`type`,`state`,`started_at`);--> statement-breakpoint
CREATE TABLE `_g_chain_tip` (
	`x` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `_g_decision_open` (
	`x` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `_g_dissent_unique` (
	`x` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `_g_evidence` (
	`x` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `_g_frozen` (
	`x` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `_g_last_admin` (
	`x` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `_g_log_summary_owner` (
	`x` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `_g_preview_fresh` (
	`x` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `_g_rev` (
	`x` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `_g_superseding` (
	`x` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `import_rows` (
	`job_id` text NOT NULL,
	`row_number` integer NOT NULL,
	`row_key` text NOT NULL,
	`outcome` text DEFAULT 'pending' NOT NULL,
	`reason` text,
	`unit_id` text,
	PRIMARY KEY(`job_id`, `row_number`),
	CONSTRAINT "import_rows_outcome_values" CHECK("import_rows"."outcome" IN ('pending', 'created', 'skipped', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `import_rows_outcome` ON `import_rows` (`job_id`,`outcome`);--> statement-breakpoint
CREATE TABLE `jobs` (
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
	CONSTRAINT "jobs_type_values" CHECK("jobs"."type" IN ('journal_import', 'bulk_import', 'public_export', 'internal_backup', 'restore', 'deletion', 'preview')),
	CONSTRAINT "jobs_state_values" CHECK("jobs"."state" IN ('queued', 'running', 'paused', 'complete', 'incomplete', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `jobs_state` ON `jobs` (`type`,`state`);--> statement-breakpoint
CREATE TABLE `moderation_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`outside_submission_id` text NOT NULL,
	`kind` text NOT NULL,
	`final` integer NOT NULL,
	`admin_id` text NOT NULL,
	`at` text NOT NULL,
	`text` text NOT NULL,
	`created_unit_ids` text,
	`changed_refs` text,
	`submission_id` text,
	CONSTRAINT "moderation_decisions_kind_values" CHECK("moderation_decisions"."kind" IN ('accepted', 'more_information_requested', 'rejected')),
	CONSTRAINT "moderation_decisions_finality" CHECK("moderation_decisions"."final" = ("moderation_decisions"."kind" <> 'more_information_requested'))
);
--> statement-breakpoint
CREATE INDEX `moderation_decisions_submission` ON `moderation_decisions` (`outside_submission_id`,`at`);--> statement-breakpoint
CREATE UNIQUE INDEX `moderation_decisions_final` ON `moderation_decisions` (`outside_submission_id`) WHERE "moderation_decisions"."final" = 1;--> statement-breakpoint
CREATE TABLE `outbox` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`topic` text NOT NULL,
	`scope` text NOT NULL,
	`change_seq` integer NOT NULL,
	`created_at` text NOT NULL,
	`done_at` text,
	CONSTRAINT "outbox_topic_values" CHECK("outbox"."topic" IN ('publish', 'search', 'mail', 'jobs'))
);
--> statement-breakpoint
CREATE INDEX `outbox_pending` ON `outbox` (`topic`,`done_at`,`seq`);--> statement-breakpoint
CREATE TABLE `outside_files` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`outside_submission_id` text,
	`response_id` text,
	`r2_key` text NOT NULL,
	`file_name` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`state` text DEFAULT 'uploading' NOT NULL,
	`created_at` text NOT NULL,
	`deleted_at` text,
	CONSTRAINT "outside_files_state_values" CHECK("outside_files"."state" IN ('uploading', 'complete', 'failed', 'deleted'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outside_files_r2_key` ON `outside_files` (`r2_key`);--> statement-breakpoint
CREATE INDEX `outside_files_session` ON `outside_files` (`session_id`);--> statement-breakpoint
CREATE INDEX `outside_files_submission` ON `outside_files` (`outside_submission_id`);--> statement-breakpoint
CREATE TABLE `outside_responses` (
	`id` text PRIMARY KEY NOT NULL,
	`outside_submission_id` text NOT NULL,
	`response_link_hash` text NOT NULL,
	`message` text NOT NULL,
	`received_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `outside_responses_submission` ON `outside_responses` (`outside_submission_id`,`received_at`);--> statement-breakpoint
CREATE TABLE `outside_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`purpose` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`outside_submission_id` text,
	CONSTRAINT "outside_sessions_purpose_values" CHECK("outside_sessions"."purpose" IN ('submission', 'response'))
);
--> statement-breakpoint
CREATE INDEX `outside_sessions_expiry` ON `outside_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `outside_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`reference` text NOT NULL,
	`type` text NOT NULL,
	`project_id` text,
	`message` text NOT NULL,
	`name` text NOT NULL,
	`email` text,
	`affiliation` text,
	`page_ref` text,
	`licence_agreed` text,
	`received_at` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`email_erase_after` text,
	`email_erased_at` text,
	`files_deleted_at` text,
	`rev` integer DEFAULT 1 NOT NULL,
	`updated_seq` integer NOT NULL,
	`actor_id` text,
	CONSTRAINT "outside_submissions_type_values" CHECK("outside_submissions"."type" IN ('material', 'correction', 'comment', 'removal_request')),
	CONSTRAINT "outside_submissions_state_values" CHECK("outside_submissions"."state" IN ('queued', 'more_information_requested', 'accepted', 'rejected')),
	CONSTRAINT "outside_submissions_email_erasure" CHECK("outside_submissions"."email_erased_at" IS NULL OR "outside_submissions"."email" IS NULL),
	CONSTRAINT "outside_submissions_licence" CHECK(("outside_submissions"."type" = 'removal_request') = ("outside_submissions"."licence_agreed" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outside_submissions_reference` ON `outside_submissions` (`reference`);--> statement-breakpoint
CREATE INDEX `outside_submissions_queue` ON `outside_submissions` (`state`,`received_at`);--> statement-breakpoint
CREATE INDEX `outside_submissions_erase` ON `outside_submissions` (`email_erase_after`) WHERE "outside_submissions"."email_erased_at" IS NULL;--> statement-breakpoint
CREATE TABLE `response_links` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`outside_submission_id` text NOT NULL,
	`decision_id` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text
);
--> statement-breakpoint
CREATE INDEX `response_links_submission` ON `response_links` (`outside_submission_id`);--> statement-breakpoint
CREATE INDEX `response_links_expiry` ON `response_links` (`expires_at`);--> statement-breakpoint
CREATE TABLE `staging_rows` (
	`token` text NOT NULL,
	`part` integer NOT NULL,
	`member_id` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`token`, `part`)
);
--> statement-breakpoint
CREATE INDEX `staging_rows_created` ON `staging_rows` (`created_at`);--> statement-breakpoint
CREATE TABLE `uploads` (
	`id` text PRIMARY KEY NOT NULL,
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
	CONSTRAINT "uploads_owner_values" CHECK("uploads"."owner_type" IN ('member', 'outside_session')),
	CONSTRAINT "uploads_mode_values" CHECK("uploads"."mode" IN ('single', 'multipart')),
	CONSTRAINT "uploads_multipart_id" CHECK(("uploads"."mode" = 'multipart') = ("uploads"."multipart_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uploads_r2_key` ON `uploads` (`r2_key`);--> statement-breakpoint
CREATE INDEX `uploads_owner` ON `uploads` (`owner_type`,`owner_id`);--> statement-breakpoint
CREATE INDEX `uploads_abandoned` ON `uploads` (`attached_at`,`created_at`);