CREATE TABLE `pronunciation_cache` (
	`language` text NOT NULL,
	`term` text NOT NULL,
	`transcription` text,
	`audio_url` text,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`language`, `term`)
);
--> statement-breakpoint
ALTER TABLE `words` ADD `transcription` text;--> statement-breakpoint
ALTER TABLE `words` ADD `pronunciation_audio_url` text;