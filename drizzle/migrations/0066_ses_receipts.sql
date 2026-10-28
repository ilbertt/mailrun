CREATE TABLE `mailrun_ses_receipts` (
  `id` text PRIMARY KEY NOT NULL,
  `result_json` text NOT NULL,
  `created_at` integer NOT NULL
);
