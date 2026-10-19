ALTER TABLE `account_history` ADD `trades_data` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `account_history` ADD `summary_data` text DEFAULT '{}' NOT NULL;