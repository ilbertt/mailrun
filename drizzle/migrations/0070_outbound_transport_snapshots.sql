-- Cloudflare Queue events retain messageId after a message is deleted. Preserve
-- that transport identity locally so cron has the same durable information.
CREATE TABLE mailrun_outbound_snapshots (
 job_id TEXT PRIMARY KEY NOT NULL REFERENCES outbound_jobs(id) ON DELETE CASCADE,
 message_id TEXT NOT NULL
);
INSERT INTO mailrun_outbound_snapshots(job_id,message_id)
 SELECT id,message_id FROM outbound_jobs WHERE message_id IS NOT NULL;
CREATE TRIGGER mailrun_capture_outbound_message AFTER INSERT ON outbound_jobs
 WHEN NEW.message_id IS NOT NULL
 BEGIN
  INSERT INTO mailrun_outbound_snapshots(job_id,message_id)
   VALUES(NEW.id,NEW.message_id);
 END;
