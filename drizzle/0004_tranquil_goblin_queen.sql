CREATE TABLE `account_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`account` text NOT NULL,
	`captured_at` text NOT NULL,
	`origin` text NOT NULL,
	`cash_value` real,
	`data` text NOT NULL,
	`received_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `account_observations_account_time` ON `account_observations` (`account`,`captured_at`);--> statement-breakpoint
CREATE TABLE `balance_adjustment_labels` (
	`id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `recorder_captures` (
	`captured_at` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`received_at` text NOT NULL
);
