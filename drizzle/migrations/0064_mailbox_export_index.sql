-- Stream all mailbox sections in source date/insertion order without repeated sorts.
-- SQLite includes rowid as the final key of this non-unique index. No persisted
-- table changes: backup groups and record restore remain unchanged.
CREATE INDEX IF NOT EXISTS messages_export_page_idx ON messages(mailbox_id,created_at);
