/**
 * State item の origin に `agent_inferred`（ホストのエージェントが依頼なしに推定した内容）を加える。
 * SQLite は列の CHECK を変更できないので、`memory_state_item` と、これを参照する 3 表
 * （`memory_state_attribute` / `memory_state_evidence` / `memory_state_event`）を作り直す。
 *
 * - 作り直す順序: 新しい親 → 新しい子 → 行の複製 → 古い子 → 古い親の削除 → 改名 → index・trigger の再作成。
 *   子を先に消すので、`foreign_keys=ON` でも親の削除が違反にならない（PRAGMA を使わない）。
 *   親の改名では、子の REFERENCES が新しい名前へ追従する（SQLite 3.26 以降。`legacy_alter_table` は ON にしない）。
 * - 行・列・値は 1 件も変えない（0004 で足した成立期間の列も複製する）。変わるのは origin の CHECK だけ。
 * - 列挙の CHECK は `src/domains/state/contracts/index.ts` のタプルと一致させる（`state-migration.test.ts` で照合）。
 */
export const sql = `
CREATE TABLE memory_state_item_v7 (
	item_id TEXT PRIMARY KEY,
	principal TEXT NOT NULL,
	scope_key TEXT NOT NULL,
	subject TEXT NOT NULL,
	kind TEXT NOT NULL
		CHECK (kind IN ('preference', 'personal_fact', 'constraint', 'habit', 'other_person_note')),
	semantic_key TEXT NOT NULL,
	status TEXT NOT NULL
		CHECK (status IN ('active', 'inactive', 'superseded', 'disputed', 'retracted', 'invalidated', 'forgotten')),
	revision INTEGER NOT NULL CHECK (revision >= 1),
	value_text TEXT,
	polarity TEXT CHECK (polarity IS NULL OR polarity IN ('affirmed', 'negated')),
	origin TEXT NOT NULL
		CHECK (origin IN ('user_confirmed', 'user_edited', 'admitted_extraction', 'agent_inferred')),
	evidence_ordinal INTEGER NOT NULL CHECK (evidence_ordinal >= 0),
	valid_from_ms INTEGER,
	valid_until_ms INTEGER,
	created_seq INTEGER NOT NULL,
	updated_seq INTEGER NOT NULL,
	valid_from_text TEXT,
	valid_until_text TEXT,
	valid_basis TEXT
		CHECK (valid_basis IS NULL OR valid_basis IN ('stated', 'inferred', 'unknown')),
	CHECK ((kind = 'other_person_note') = (subject LIKE 'other:%')),
	CHECK (subject = 'self' OR subject LIKE 'other:%'),
	CHECK (status = 'forgotten' OR (value_text IS NOT NULL AND polarity IS NOT NULL))
);
CREATE TABLE memory_state_attribute_v7 (
	item_id TEXT NOT NULL REFERENCES memory_state_item_v7 (item_id),
	attr_key TEXT NOT NULL,
	attr_value TEXT NOT NULL,
	PRIMARY KEY (item_id, attr_key)
);
CREATE TABLE memory_state_evidence_v7 (
	item_id TEXT NOT NULL REFERENCES memory_state_item_v7 (item_id),
	idx INTEGER NOT NULL CHECK (idx >= 0),
	source_key TEXT NOT NULL,
	namespace TEXT NOT NULL,
	kind TEXT NOT NULL,
	source_id TEXT NOT NULL,
	representation TEXT,
	revision TEXT NOT NULL,
	digest TEXT NOT NULL,
	start_byte INTEGER NOT NULL,
	end_byte INTEGER NOT NULL,
	PRIMARY KEY (item_id, idx),
	CHECK (start_byte >= 0 AND end_byte > start_byte)
);
CREATE TABLE memory_state_event_v7 (
	event_seq INTEGER PRIMARY KEY,
	item_id TEXT NOT NULL REFERENCES memory_state_item_v7 (item_id),
	principal TEXT NOT NULL,
	scope_key TEXT NOT NULL,
	action TEXT NOT NULL
		CHECK (action IN ('assert', 'activate', 'edit', 'supersede', 'dispute', 'retract', 'deactivate', 'reactivate', 'invalidate', 'forget')),
	from_revision INTEGER,
	to_revision INTEGER,
	cause_type TEXT NOT NULL CHECK (cause_type IN ('user', 'candidate', 'lifecycle')),
	cause_id TEXT NOT NULL,
	at_ms INTEGER NOT NULL
);

INSERT INTO memory_state_item_v7
	(item_id, principal, scope_key, subject, kind, semantic_key, status, revision, value_text, polarity,
	 origin, evidence_ordinal, valid_from_ms, valid_until_ms, created_seq, updated_seq,
	 valid_from_text, valid_until_text, valid_basis)
SELECT item_id, principal, scope_key, subject, kind, semantic_key, status, revision, value_text, polarity,
	 origin, evidence_ordinal, valid_from_ms, valid_until_ms, created_seq, updated_seq,
	 valid_from_text, valid_until_text, valid_basis
FROM memory_state_item;
INSERT INTO memory_state_attribute_v7 (item_id, attr_key, attr_value)
SELECT item_id, attr_key, attr_value FROM memory_state_attribute;
INSERT INTO memory_state_evidence_v7
	(item_id, idx, source_key, namespace, kind, source_id, representation, revision, digest, start_byte, end_byte)
SELECT item_id, idx, source_key, namespace, kind, source_id, representation, revision, digest, start_byte, end_byte
FROM memory_state_evidence;
INSERT INTO memory_state_event_v7
	(event_seq, item_id, principal, scope_key, action, from_revision, to_revision, cause_type, cause_id, at_ms)
SELECT event_seq, item_id, principal, scope_key, action, from_revision, to_revision, cause_type, cause_id, at_ms
FROM memory_state_event;

DROP TABLE memory_state_attribute;
DROP TABLE memory_state_evidence;
DROP TABLE memory_state_event;
DROP TABLE memory_state_item;

ALTER TABLE memory_state_item_v7 RENAME TO memory_state_item;
ALTER TABLE memory_state_attribute_v7 RENAME TO memory_state_attribute;
ALTER TABLE memory_state_evidence_v7 RENAME TO memory_state_evidence;
ALTER TABLE memory_state_event_v7 RENAME TO memory_state_event;

CREATE INDEX memory_state_item_by_scope
	ON memory_state_item (principal, scope_key, status, updated_seq);
CREATE INDEX memory_state_item_by_key
	ON memory_state_item (principal, scope_key, subject, kind, semantic_key, status);
CREATE UNIQUE INDEX memory_state_item_one_active_per_key
	ON memory_state_item (principal, scope_key, subject, kind, semantic_key)
	WHERE status = 'active';
CREATE INDEX memory_state_event_by_item ON memory_state_event (item_id, event_seq);
CREATE INDEX memory_state_event_by_scope ON memory_state_event (principal, scope_key, event_seq);

CREATE TRIGGER memory_state_item_no_resurrection
BEFORE INSERT ON memory_state_item
WHEN EXISTS (
	SELECT 1 FROM memory_tombstone
	WHERE target_type = 'state_item' AND target_id = NEW.item_id
)
BEGIN
	SELECT RAISE(ABORT, 'memory_tombstoned');
END;
`;
