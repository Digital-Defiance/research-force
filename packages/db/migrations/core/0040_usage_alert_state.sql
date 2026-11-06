-- Task 44.2: the per-allowance, per-period de-duplication marker for the usage-alert state machine (R19.10, R28.2).
-- The every-15-minutes usage check combines the OPS analytics with the Budget figures for the Public_Traffic_Budget,
-- the AI_Allocation, and the Recipient_Cap, and raises ONE System_Alert for every Administrator each time an
-- allowance's usage rises from below 80% to 80% or more within its period (the UTC day on which all three reset).
-- This single-row-per-(allowance, period) marker records only the ARMED flag of that crossing state machine: 1 while
-- the allowance is primed to alert on the next upward crossing (it has been observed below 80% in this period), 0
-- after an alert has fired and while usage stays at or above 80%. It re-arms when usage falls back below 80% within
-- the period, and a new period starts fresh. It is operational state only: a content-free allowance name, a UTC-day
-- period key, and the armed flag, never a research body or recipient address, and it is EXCLUDED from backups exactly
-- like `backup_alert_state`.
CREATE TABLE `usage_alert_state` (
	`allowance` text NOT NULL,
	`period` text NOT NULL,
	`armed` integer DEFAULT 1 NOT NULL,
	`at` text NOT NULL,
	PRIMARY KEY(`allowance`, `period`)
);
