ALTER TABLE `email_batches` ADD `queued_at` text;--> statement-breakpoint
ALTER TABLE `email_batches` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `email_batches` ADD `next_attempt_at` text;--> statement-breakpoint
ALTER TABLE `email_batches` ADD `first_failed_at` text;--> statement-breakpoint
ALTER TABLE `email_batches` ADD `held_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `email_batches` ADD `sent_at` text;--> statement-breakpoint
ALTER TABLE `email_batches` ADD `failed_at` text;--> statement-breakpoint
ALTER TABLE `outgoing_emails` ADD `first_failed_at` text;