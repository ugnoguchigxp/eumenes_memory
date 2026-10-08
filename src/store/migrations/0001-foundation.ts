/**
 * 0001 foundation: S1〜S6 が共有する土台（full-system-design §2.4）。
 * 規則: 1 回の exec で完結。BEGIN/COMMIT・PRAGMA・ホスト表への DDL/FK を含めない。
 * 版と hash の記録（`memory_schema_info` への INSERT）は `index.ts` が末尾に付ける。
 * 採用前は並べ替え・統合してよい（採用後は追記専用。`spec/verification-status.md` の凍結点を参照）。
 *
 * JSON を含む列（`request_json`）は、本体が JSON 文字列として読み込まない（src の規則）。読む必要があれば
 * SQL の json_extract / json_each を使うか、列に分解して保存する。
 *
 * 列挙の CHECK は `src/contracts/lifecycle.ts` 等のタプルと一致させる（テストで照合）。
 */
export const sql = `
CREATE TABLE memory_schema_info (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

CREATE TABLE memory_seq (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	value INTEGER NOT NULL
);
INSERT INTO memory_seq (id, value) VALUES (1, 0);

CREATE TABLE memory_scope_state (
	principal TEXT NOT NULL,
	scope_key TEXT NOT NULL,
	revision INTEGER NOT NULL,
	PRIMARY KEY (principal, scope_key)
);

CREATE TABLE memory_dependency (
	principal TEXT NOT NULL,
	scope_key TEXT NOT NULL,
	dependent_type TEXT NOT NULL
		CHECK (dependent_type IN ('state_item', 'candidate', 'extraction_run', 'external')),
	dependent_id TEXT NOT NULL,
	dependency_type TEXT NOT NULL
		CHECK (dependency_type IN ('source', 'state_item', 'candidate', 'extraction_run')),
	dependency_id TEXT NOT NULL,
	role TEXT NOT NULL
		CHECK (role IN ('primary', 'support', 'input', 'derived_from')),
	PRIMARY KEY (dependent_type, dependent_id, dependency_type, dependency_id, role)
);
CREATE INDEX memory_dependency_by_dependency
	ON memory_dependency (dependency_type, dependency_id);
CREATE INDEX memory_dependency_by_scope
	ON memory_dependency (principal, scope_key);

CREATE TABLE memory_tombstone (
	target_type TEXT NOT NULL
		CHECK (target_type IN ('record', 'source', 'state_item', 'candidate', 'extraction_run', 'external')),
	target_id TEXT NOT NULL,
	principal TEXT NOT NULL,
	scope_key TEXT NOT NULL,
	forget_id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	journal_seq INTEGER NOT NULL,
	PRIMARY KEY (target_type, target_id)
);
CREATE INDEX memory_tombstone_by_forget ON memory_tombstone (forget_id);

CREATE TABLE memory_forget (
	forget_id TEXT PRIMARY KEY,
	principal TEXT NOT NULL,
	request_json TEXT NOT NULL,
	local_state TEXT NOT NULL CHECK (local_state IN ('applied')),
	external_state TEXT NOT NULL
		CHECK (external_state IN ('none', 'pending', 'unverified', 'confirmed', 'failed')),
	journal_seq INTEGER NOT NULL UNIQUE,
	entry_hash TEXT NOT NULL,
	seq INTEGER NOT NULL,
	at_ms INTEGER NOT NULL
);

CREATE TABLE memory_forget_external (
	forget_id TEXT NOT NULL,
	provider_ref TEXT NOT NULL,
	external_id TEXT NOT NULL DEFAULT '',
	state TEXT NOT NULL
		CHECK (state IN ('pending', 'unverified', 'confirmed', 'failed')),
	updated_seq INTEGER NOT NULL,
	PRIMARY KEY (forget_id, provider_ref, external_id)
);

CREATE TABLE memory_journal_state (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	applied_head_seq INTEGER NOT NULL,
	applied_head_hash TEXT NOT NULL
);
INSERT INTO memory_journal_state (id, applied_head_seq, applied_head_hash)
	VALUES (1, 0, '0000000000000000000000000000000000000000000000000000000000000000');

CREATE TABLE memory_change (
	seq INTEGER PRIMARY KEY,
	principal TEXT NOT NULL,
	scope_key TEXT NOT NULL,
	target_type TEXT NOT NULL CHECK (target_type IN ('record', 'state_item', 'source')),
	target_id TEXT NOT NULL,
	revision TEXT,
	status TEXT NOT NULL
		CHECK (status IN ('active', 'inactive', 'superseded', 'disputed', 'retracted', 'invalidated', 'forgotten')),
	forget_id TEXT,
	at_ms INTEGER NOT NULL
);
CREATE INDEX memory_change_by_scope ON memory_change (principal, scope_key, seq);
`;
