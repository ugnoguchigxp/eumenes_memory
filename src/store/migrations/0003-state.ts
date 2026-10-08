/**
 * 0003 state / extraction。前半が state（S3）、後半が extraction（S5: memory_extraction_run / _input / _shown、
 * memory_candidate / _evidence、memory_source_progress と各 no_resurrection trigger）。採用前は 1 本に統合、
 * 採用後は extraction を 0004 に分ける。
 *
 * 規則は 0001 と同じ（1 回の exec で完結、transaction 制御・PRAGMA・ホスト表への DDL/FK を含めない。trigger 本体の開始・終了語は除く）。
 * 列挙の CHECK は `src/contracts/state.ts` のタプルと一致させる（`src/store/test/state-migration.test.ts` で照合）。
 *
 * JSON 文字列の列は作らない（src は JSON を文字列から読み込めない）。`StateValue.attributes` は
 * `memory_state_attribute` に、evidence は `memory_state_evidence` に分解して保存する。
 *
 * forgotten（S6 の閉包適用が書く）の行の規約: `memory_state_item` は value_text / polarity を NULL、semantic_key を ''
 * にし、`memory_state_attribute` / `memory_state_evidence` の行を削除する。`memory_state_event` は action と seq だけ残す。
 *
 * 依存辺（`memory_dependency`）: state_item は evidence の出典（dependency_type `source`、id は SourceKey）に
 * 必ず辺を持つ（先頭の evidence が `primary`、残りが `support`）。
 *
 * extraction の規約（S5）:
 * - 本文を持たない列: run / input / shown / progress は出典の本文を保存しない（SourceRef 相当と digest だけ）。
 *   candidate は value_text（モデルが出した値）を持ち、forgotten（S6 の閉包適用が書く）では value_text / polarity を
 *   NULL、semantic_key を '' にし、memory_candidate_evidence の行を削除する。
 * - 依存辺: extraction_run → 入力の各 source（role input）と、見せた state_item（role input）。
 *   candidate → extraction_run（derived_from）と、検査を通った evidence の各 source（primary / support）。
 *   抽出由来・確認由来の state_item → candidate（derived_from）。run の入力を forget すると run の全 candidate と
 *   そこから作った item が閉包に入る（引用されなかった入力も含む）。
 * - candidate の evidence は quote 本文を保存せず quote_digest（range の bytes の SHA-256）だけ持つ。
 * - 列挙の CHECK は src/contracts のタプル（reason_code は ADMISSION_REASON_CODES）と一致させる。
 */
export const sql = `
CREATE TABLE memory_state_item (
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
		CHECK (origin IN ('user_confirmed', 'user_edited', 'admitted_extraction')),
	evidence_ordinal INTEGER NOT NULL CHECK (evidence_ordinal >= 0),
	valid_from_ms INTEGER,
	valid_until_ms INTEGER,
	created_seq INTEGER NOT NULL,
	updated_seq INTEGER NOT NULL,
	CHECK ((kind = 'other_person_note') = (subject LIKE 'other:%')),
	CHECK (subject = 'self' OR subject LIKE 'other:%'),
	CHECK (status = 'forgotten' OR (value_text IS NOT NULL AND polarity IS NOT NULL))
);
CREATE INDEX memory_state_item_by_scope
	ON memory_state_item (principal, scope_key, status, updated_seq);
CREATE INDEX memory_state_item_by_key
	ON memory_state_item (principal, scope_key, subject, kind, semantic_key, status);
CREATE UNIQUE INDEX memory_state_item_one_active_per_key
	ON memory_state_item (principal, scope_key, subject, kind, semantic_key)
	WHERE status = 'active';

CREATE TRIGGER memory_state_item_no_resurrection
BEFORE INSERT ON memory_state_item
WHEN EXISTS (
	SELECT 1 FROM memory_tombstone
	WHERE target_type = 'state_item' AND target_id = NEW.item_id
)
BEGIN
	SELECT RAISE(ABORT, 'memory_tombstoned');
END;

CREATE TABLE memory_state_attribute (
	item_id TEXT NOT NULL REFERENCES memory_state_item (item_id),
	attr_key TEXT NOT NULL,
	attr_value TEXT NOT NULL,
	PRIMARY KEY (item_id, attr_key)
);

CREATE TABLE memory_state_evidence (
	item_id TEXT NOT NULL REFERENCES memory_state_item (item_id),
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

CREATE TABLE memory_state_event (
	event_seq INTEGER PRIMARY KEY,
	item_id TEXT NOT NULL REFERENCES memory_state_item (item_id),
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
CREATE INDEX memory_state_event_by_item ON memory_state_event (item_id, event_seq);
CREATE INDEX memory_state_event_by_scope ON memory_state_event (principal, scope_key, event_seq);

CREATE TABLE memory_extraction_run (
	run_id TEXT PRIMARY KEY,
	principal TEXT NOT NULL,
	scope_key TEXT NOT NULL,
	stage TEXT NOT NULL
		CHECK (stage IN ('prepared', 'settled', 'stale', 'rejected_output')),
	input_digest TEXT NOT NULL,
	extractor_id TEXT NOT NULL,
	prompt_version TEXT NOT NULL,
	provider_ref TEXT NOT NULL,
	prepared_seq INTEGER NOT NULL,
	settled_seq INTEGER,
	outcome_code TEXT,
	output_digest TEXT,
	admitted_count INTEGER,
	pending_count INTEGER,
	rejected_count INTEGER,
	CHECK ((stage = 'prepared') = (settled_seq IS NULL))
);
CREATE INDEX memory_extraction_run_by_scope
	ON memory_extraction_run (principal, scope_key, stage, prepared_seq);

CREATE TRIGGER memory_extraction_run_no_resurrection
BEFORE INSERT ON memory_extraction_run
WHEN EXISTS (
	SELECT 1 FROM memory_tombstone
	WHERE target_type = 'extraction_run' AND target_id = NEW.run_id
)
BEGIN
	SELECT RAISE(ABORT, 'memory_tombstoned');
END;

CREATE TABLE memory_extraction_input (
	run_id TEXT NOT NULL REFERENCES memory_extraction_run (run_id),
	idx INTEGER NOT NULL CHECK (idx >= 0),
	source_key TEXT NOT NULL,
	namespace TEXT NOT NULL,
	kind TEXT NOT NULL,
	source_id TEXT NOT NULL,
	representation TEXT,
	revision TEXT NOT NULL,
	digest TEXT NOT NULL,
	role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
	ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
	PRIMARY KEY (run_id, source_key),
	UNIQUE (run_id, idx)
);

CREATE TABLE memory_extraction_shown (
	run_id TEXT NOT NULL REFERENCES memory_extraction_run (run_id),
	item_id TEXT NOT NULL,
	revision INTEGER NOT NULL CHECK (revision >= 1),
	PRIMARY KEY (run_id, item_id)
);

CREATE TABLE memory_candidate (
	candidate_id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES memory_extraction_run (run_id),
	idx INTEGER NOT NULL CHECK (idx >= 0),
	principal TEXT NOT NULL,
	scope_key TEXT NOT NULL,
	kind TEXT NOT NULL
		CHECK (kind IN ('preference', 'personal_fact', 'constraint', 'habit', 'other_person_note')),
	subject TEXT NOT NULL,
	semantic_key TEXT NOT NULL,
	value_text TEXT,
	polarity TEXT CHECK (polarity IS NULL OR polarity IN ('affirmed', 'negated')),
	modality TEXT NOT NULL
		CHECK (modality IN ('asserted', 'hypothetical', 'quoted', 'reported', 'question')),
	temporal TEXT NOT NULL
		CHECK (temporal IN ('current', 'past', 'future', 'unspecified')),
	decision TEXT NOT NULL
		CHECK (decision IN ('admitted', 'pending_user', 'rejected', 'invalidated', 'forgotten')),
	reason_code TEXT
		CHECK (reason_code IS NULL OR reason_code IN ('INVALID_CANDIDATE', 'QUOTE_MISMATCH', 'EVIDENCE_NOT_IN_INPUT', 'SOURCE_STALE', 'HOST_OWNED_KIND', 'MODALITY_QUOTED', 'MODALITY_NOT_ASSERTED', 'SUBJECT_OTHER', 'SUBJECT_UNKNOWN', 'TEMPORAL_NOT_CURRENT', 'NOT_USER_SOURCE', 'OLDER_EVIDENCE', 'POLICY_NEVER', 'POLICY_REQUIRES_USER')),
	evidence_ordinal INTEGER NOT NULL CHECK (evidence_ordinal >= 0),
	replaces_item_id TEXT,
	replaces_revision INTEGER,
	admitted_item_id TEXT,
	resolution TEXT CHECK (resolution IS NULL OR resolution IN ('user_admitted', 'user_rejected')),
	created_seq INTEGER NOT NULL,
	resolved_seq INTEGER,
	UNIQUE (run_id, idx),
	CHECK (decision = 'forgotten' OR (value_text IS NOT NULL AND polarity IS NOT NULL)),
	CHECK ((replaces_item_id IS NULL) = (replaces_revision IS NULL))
);
CREATE INDEX memory_candidate_by_scope
	ON memory_candidate (principal, scope_key, decision, created_seq);
CREATE INDEX memory_candidate_by_run ON memory_candidate (run_id, idx);

CREATE TRIGGER memory_candidate_no_resurrection
BEFORE INSERT ON memory_candidate
WHEN EXISTS (
	SELECT 1 FROM memory_tombstone
	WHERE target_type = 'candidate' AND target_id = NEW.candidate_id
)
BEGIN
	SELECT RAISE(ABORT, 'memory_tombstoned');
END;

CREATE TABLE memory_candidate_evidence (
	candidate_id TEXT NOT NULL REFERENCES memory_candidate (candidate_id),
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
	quote_digest TEXT NOT NULL,
	PRIMARY KEY (candidate_id, idx),
	CHECK (start_byte >= 0 AND end_byte > start_byte)
);

CREATE TABLE memory_source_progress (
	principal TEXT NOT NULL,
	scope_key TEXT NOT NULL,
	source_key TEXT NOT NULL,
	processed_revision TEXT NOT NULL,
	stage TEXT NOT NULL CHECK (stage IN ('extracted', 'no_change', 'failed_output')),
	run_id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	PRIMARY KEY (principal, scope_key, source_key)
);

CREATE TRIGGER memory_source_progress_no_resurrection
BEFORE INSERT ON memory_source_progress
WHEN EXISTS (
	SELECT 1 FROM memory_tombstone
	WHERE target_type = 'source' AND target_id = NEW.source_key
)
BEGIN
	SELECT RAISE(ABORT, 'memory_tombstoned');
END;
`;
