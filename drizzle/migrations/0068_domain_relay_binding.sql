-- Imported Cloudflare routing flags do not establish a connection to this server.
-- Keep the successful native binding alongside the domain's existing routing state.
ALTER TABLE domains ADD COLUMN mailrun_relay_worker_name text;
ALTER TABLE domains ADD COLUMN mailrun_relay_zone_id text;

-- A completed native first-domain setup is authoritative evidence for that
-- exact hostname/zone. Do not infer bindings for other imported domains.
UPDATE domains
SET mailrun_relay_worker_name = (
 SELECT worker_name FROM mailrun_installation WHERE id='primary'
), mailrun_relay_zone_id = zone_id
WHERE routing_enabled=1 AND EXISTS (
 SELECT 1 FROM mailrun_installation
 WHERE id='primary' AND phase='ready'
 AND hostname=domains.hostname AND zone_id=domains.zone_id
);
