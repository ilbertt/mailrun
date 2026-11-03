-- Existing record backups include these columns automatically. Older backups
-- omit them and restore with revision zero and no scheduled time.
ALTER TABLE messages ADD COLUMN draft_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN draft_scheduled_at INTEGER;
