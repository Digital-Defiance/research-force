-- Task 67.3: the AUDITED, CONTENT-FREE failure AGGREGATE kept past the 90-day per-failure horizon (R60.6, R60.8:
-- "aggregate/audited failure metadata for 90 days"). The operational-retention sweep folds each expired per-failure
-- external-operation row into a (kind, detail) bucket here before dropping the individual rows, so the audited count
-- and the window it covers survive while no research body, bearer link, or recovery secret is retained. This is
-- operational state, never a snapshotted research row, so the backup inventory excludes it (R60.1).
CREATE TABLE `operation_failure_aggregates` (
	`kind` text NOT NULL,
	`detail` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`first_at` text NOT NULL,
	`last_at` text NOT NULL,
	PRIMARY KEY(`kind`, `detail`),
	CONSTRAINT "operation_failure_aggregates_count" CHECK("operation_failure_aggregates"."count" >= 0),
	CONSTRAINT "operation_failure_aggregates_detail_bytes" CHECK(length(CAST("operation_failure_aggregates"."detail" AS BLOB)) <= 500)
);
