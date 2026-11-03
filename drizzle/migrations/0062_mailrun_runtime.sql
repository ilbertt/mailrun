CREATE TABLE mailrun_installation (
	id TEXT PRIMARY KEY NOT NULL CHECK (id = 'primary'),
	account_id TEXT NOT NULL,
	zone_id TEXT NOT NULL,
	hostname TEXT NOT NULL,
	worker_name TEXT NOT NULL,
	public_origin TEXT NOT NULL,
	api_token TEXT NOT NULL,
	relay_secret TEXT NOT NULL,
	relay_version TEXT NOT NULL,
	phase TEXT NOT NULL DEFAULT 'saved',
	updated_at INTEGER NOT NULL
);

-- Runtime locks are internally managed and deliberately excluded from backups.
-- Their contents expire and must never be restored into a different process.
CREATE TABLE mailrun_job_leases (
	name TEXT PRIMARY KEY NOT NULL,
	owner TEXT NOT NULL,
	expires_at INTEGER NOT NULL
);
