CREATE TABLE `price_bars` (
	`contract` text NOT NULL,
	`start` integer NOT NULL,
	`open` real NOT NULL,
	`high` real NOT NULL,
	`low` real NOT NULL,
	`close` real NOT NULL,
	`volume` integer NOT NULL,
	`captured_at` integer NOT NULL,
	`received_at` integer NOT NULL,
	PRIMARY KEY(`contract`, `start`)
);
