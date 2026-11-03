-- Local upload metadata replaces R2 object metadata. Deleting this row inside
-- the draft transaction atomically claims a MIME upload, even if file cleanup fails.
CREATE TABLE mailrun_jmap_uploads (
 id TEXT PRIMARY KEY NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 r2_key TEXT NOT NULL,
 content_type TEXT NOT NULL,
 name TEXT,
 size INTEGER NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX mailrun_jmap_uploads_user_idx ON mailrun_jmap_uploads(user_id);
