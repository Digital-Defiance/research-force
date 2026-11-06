-- Task 43.3: the per-Policy_Page record of the generated content a build last published and the UTC date that
-- content last changed (R46.29). A page's last-updated date is the latest of its Policy_Section change, its
-- fixed-text version date, and a change to the generated content it presents (the People profiles, the Methods_Terms
-- and Public_Descriptions, the Content_Licence name, the Retention_Table, and the Responsible_Person's display name).
-- The Publisher hashes that generated content each build; `generated_hash` holds the last published hash and
-- `generated_changed_at` the UTC date it last differed, so a rebuild whose generated content is unchanged keeps the
-- same date and only a real change advances it. Both are NULL until the first build records them.
ALTER TABLE `policy_pages` ADD `generated_hash` text;--> statement-breakpoint
ALTER TABLE `policy_pages` ADD `generated_changed_at` text;
