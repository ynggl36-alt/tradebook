CREATE TABLE `account_history` (
	`account` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `account_profiles` (
	`account` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cash_records` (
	`id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `journal_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`added` integer NOT NULL,
	`duplicates` integer NOT NULL,
	`imported_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `journal_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `trade_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`account` text NOT NULL,
	`data` text NOT NULL
);
