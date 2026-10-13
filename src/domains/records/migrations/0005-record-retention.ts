export const sql = `
CREATE TABLE memory_record_retention (
	record_id TEXT PRIMARY KEY,
	record_revision TEXT NOT NULL,
	fresh_until_ms INTEGER NOT NULL,
	last_used_at_ms INTEGER NOT NULL,
	idle_ttl_ms INTEGER NOT NULL,
	idle_expires_at_ms INTEGER NOT NULL,
	retention_revision INTEGER NOT NULL
);
CREATE INDEX memory_record_retention_idle ON memory_record_retention(idle_expires_at_ms);
CREATE INDEX memory_record_retention_lru ON memory_record_retention(last_used_at_ms, record_id);
`;
