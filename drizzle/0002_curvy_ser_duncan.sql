CREATE TABLE `account_status` (
	`account` text PRIMARY KEY NOT NULL,
	`captured_at` text NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `recorder_status` (
	`id` text PRIMARY KEY NOT NULL,
	`captured_at` text NOT NULL,
	`data` text NOT NULL
);
