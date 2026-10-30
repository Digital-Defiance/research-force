CREATE TABLE `decision_events` (
	`decision_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`actor_id` text,
	`at` text NOT NULL,
	`reason` text,
	`related_id` text,
	PRIMARY KEY(`decision_id`, `seq`),
	CONSTRAINT "decision_events_kind_values" CHECK("decision_events"."kind" IN ('adopted', 'superseded', 'withdrawn', 'revisit_due')),
	CONSTRAINT "decision_events_seq" CHECK("decision_events"."seq" >= 1)
);
--> statement-breakpoint
ALTER TABLE `decisions` ADD `revisit_reminded_at` text;--> statement-breakpoint
-- What happened to a decision is added, never changed (R53.4).
CREATE TRIGGER `decision_events_immutable` BEFORE UPDATE ON `decision_events`
BEGIN SELECT RAISE(ABORT, 'decision_event_immutable'); END;
