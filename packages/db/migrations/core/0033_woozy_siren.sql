CREATE TABLE `contact_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`outside_submission_id` text NOT NULL,
	`action` text NOT NULL,
	`reason` text,
	`admin_id` text NOT NULL,
	`at` text NOT NULL,
	CONSTRAINT "contact_reviews_action_values" CHECK("contact_reviews"."action" IN ('keep', 'erase')),
	CONSTRAINT "contact_reviews_reason" CHECK(("contact_reviews"."action" = 'keep') = ("contact_reviews"."reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `contact_reviews_submission` ON `contact_reviews` (`outside_submission_id`,`at`);--> statement-breakpoint
CREATE TABLE `submitter_corrections` (
	`id` text PRIMARY KEY NOT NULL,
	`outside_submission_id` text NOT NULL,
	`kind` text NOT NULL,
	`erased` integer DEFAULT false NOT NULL,
	`new_name` text,
	`new_affiliation` text,
	`new_email` text,
	`prev_name` text,
	`prev_affiliation` text,
	`prev_email` text,
	`admin_id` text NOT NULL,
	`reason` text NOT NULL,
	`at` text NOT NULL,
	CONSTRAINT "submitter_corrections_kind_values" CHECK("submitter_corrections"."kind" IN ('attribution', 'contact')),
	CONSTRAINT "submitter_corrections_erased" CHECK("submitter_corrections"."erased" = 0 OR "submitter_corrections"."kind" = 'contact'),
	CONSTRAINT "submitter_corrections_erase_values" CHECK("submitter_corrections"."erased" = 0 OR ("submitter_corrections"."new_email" IS NULL AND "submitter_corrections"."prev_email" IS NULL)),
	CONSTRAINT "submitter_corrections_shape" CHECK(
    ("submitter_corrections"."kind" = 'attribution' AND "submitter_corrections"."new_email" IS NULL AND "submitter_corrections"."prev_email" IS NULL)
    OR ("submitter_corrections"."kind" = 'contact' AND "submitter_corrections"."new_name" IS NULL AND "submitter_corrections"."new_affiliation" IS NULL AND "submitter_corrections"."prev_name" IS NULL AND "submitter_corrections"."prev_affiliation" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `submitter_corrections_submission` ON `submitter_corrections` (`outside_submission_id`,`at`);--> statement-breakpoint
ALTER TABLE `outside_submissions` ADD `contact_review_due_at` text;--> statement-breakpoint
ALTER TABLE `outside_submissions` ADD `contact_review_reminded_day` integer;--> statement-breakpoint
CREATE INDEX `outside_submissions_contact_review` ON `outside_submissions` (`contact_review_due_at`) WHERE "outside_submissions"."contact_review_due_at" IS NOT NULL AND "outside_submissions"."email_erased_at" IS NULL;
--> statement-breakpoint
-- Contact_Reviews are appended and never changed (R32.20).
CREATE TRIGGER `contact_reviews_immutable` BEFORE UPDATE ON `contact_reviews`
BEGIN SELECT RAISE(ABORT, 'contact reviews are immutable'); END;
--> statement-breakpoint
-- Submitter corrections are appended and never changed (R32.22).
CREATE TRIGGER `submitter_corrections_immutable` BEFORE UPDATE ON `submitter_corrections`
BEGIN SELECT RAISE(ABORT, 'submitter corrections are immutable'); END;
