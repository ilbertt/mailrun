-- Protocol submissions keep their source draft unchanged until delivery succeeds.
-- Keep the cleanup association outside the source-format transport payload and
-- outside message revisions. It must survive a process crash and record restore.
CREATE TABLE mailrun_submission_drafts (
 job_id TEXT PRIMARY KEY NOT NULL REFERENCES outbound_jobs(id) ON DELETE CASCADE,
 draft_id TEXT NOT NULL,
 draft_revision INTEGER NOT NULL
);
CREATE INDEX mailrun_submission_drafts_draft ON mailrun_submission_drafts(draft_id);
-- draft_id deliberately has no message FK: cleanup must also complete safely
-- when that draft was already removed. Deleting the job removes this ledger.
