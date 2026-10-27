-- Statements Drizzle does not model: expression indexes and triggers.

-- One active Cross_Link per origin, target, and relation label; an unlabelled link counts as one label (R15.2).
CREATE UNIQUE INDEX `cross_links_active` ON `cross_links` (`origin_id`, `target_id`, ifnull(`relation_value_id`, '')) WHERE `removed_at` IS NULL;
--> statement-breakpoint
-- No API changes a Revision; only the permanent-deletion job deletes Revision rows (R22.11).
CREATE TRIGGER `revisions_immutable` BEFORE UPDATE ON `revisions`
BEGIN SELECT RAISE(ABORT, 'revisions are immutable'); END;
--> statement-breakpoint
-- Moderation_Decisions are appended and never changed (R32.13).
CREATE TRIGGER `moderation_decisions_immutable` BEFORE UPDATE ON `moderation_decisions`
BEGIN SELECT RAISE(ABORT, 'moderation decisions are immutable'); END;
--> statement-breakpoint
-- An issued Item_Identifier is never reissued, even after permanent deletion (R15.6).
CREATE TRIGGER `identifiers_permanent_update` BEFORE UPDATE ON `identifiers`
BEGIN SELECT RAISE(ABORT, 'identifiers are permanent'); END;
--> statement-breakpoint
CREATE TRIGGER `identifiers_permanent_delete` BEFORE DELETE ON `identifiers`
BEGIN SELECT RAISE(ABORT, 'identifiers are permanent'); END;
