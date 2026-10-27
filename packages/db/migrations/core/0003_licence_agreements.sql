CREATE TABLE `licence_agreements` (
	`member_id` text NOT NULL,
	`licence_name` text NOT NULL,
	`given_on` text NOT NULL,
	PRIMARY KEY(`member_id`, `licence_name`)
);
--> statement-breakpoint
-- A Licence_Agreement, once given, is kept and cannot be withdrawn (R46.16).
CREATE TRIGGER `licence_agreements_kept_update` BEFORE UPDATE ON `licence_agreements`
BEGIN SELECT RAISE(ABORT, 'licence agreements are kept'); END;
--> statement-breakpoint
CREATE TRIGGER `licence_agreements_kept_delete` BEFORE DELETE ON `licence_agreements`
BEGIN SELECT RAISE(ABORT, 'licence agreements are kept'); END;
