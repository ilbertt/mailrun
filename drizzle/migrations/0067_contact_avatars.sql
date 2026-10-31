CREATE TABLE `mailrun_contact_avatar_jobs` (
 `contact_id` text PRIMARY KEY NOT NULL REFERENCES `contacts`(`id`) ON DELETE CASCADE,
 `mailbox_ids` text DEFAULT '[]' NOT NULL,
 `status` text DEFAULT 'pending' NOT NULL,
 `owner` text,
 `lease_until` integer,
 `attempts` integer DEFAULT 0 NOT NULL,
 `published` integer DEFAULT 0 NOT NULL,
 `error` text,
 `created_at` integer NOT NULL
);
CREATE INDEX `mailrun_avatar_job_status` ON `mailrun_contact_avatar_jobs` (`status`, `created_at`);
CREATE TABLE `mailrun_contact_avatar_revisions` (
 `mailbox_id` text PRIMARY KEY NOT NULL REFERENCES `mailboxes`(`id`) ON DELETE CASCADE,
 `revision` integer DEFAULT 0 NOT NULL
);
