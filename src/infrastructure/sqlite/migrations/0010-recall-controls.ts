/**
 * 0010 recall controls: Eumenes の記憶系の作り直し（設計 `memory-architecture-redesign-2026-11-22` の段 1・2・4・6 の前提）で
 * 要る永続物を、1 回の版上げ（DB スキーマ版 9 → 10）でまとめて足す。既存の表・行は 1 つも作り直さず、追記だけで行う。
 *
 * - 即時の除外: `memory_exclusion`。忘却の依頼を受けた直後に、閉包削除が終わるまで対象（State item・記憶の候補）を
 *   検索・一覧のすべての照会から外す印。付与・解除は journal（format 3）に載るので、DB の復元と journal の再適用で戻る。
 *   本文・semantic_key を持たない（ID だけ）。閉包削除が対象を墓標にしたとき、同じ transaction で消える。
 * - 抑制: `memory_suppression`。「話題に出さない」。記録は残す。State item か、同じ事実（subject・kind・semantic_key。
 *   以後の新しい版にも効く）に付ける。journal には載せない（忘却ではなく、復元で失えば付け直す）。事実を指す行は
 *   semantic_key を持つので、その事実の全版が忘却されたとき閉包削除が消す。
 * - 記憶の候補（L1）: `memory_inferred_candidate` / `_evidence`。推定・観測の候補で、origin は `agent_inferred` だけ。
 *   根拠（出典の範囲）は必須で、観測の回数と観測した会話は根拠の行から導く。旧候補の表（0003 の `memory_candidate`、
 *   0008 で削除）の形は戻さない（抽出 run・admission 判定・modality は持たない）。依存辺と墓標の語彙は 0001 の CHECK に
 *   残っている `candidate` を使う。
 * - 強度: `memory_state_item.strength`（検索の順位の重み、0〜1、既定 1）。
 * - 変更フィード: `memory_change` に、変更を起こした run（`source_run_id`）、変更の種類（`change_kind`）、置き換えた新版
 *   （`successor_id`）の 3 列を足す（どれも省略可）。
 *
 * 列挙の CHECK は `src/domains/state/contracts/index.ts` と `src/contracts/external.ts` のタプルと一致させる
 * （`migrations.test.ts` で照合）。規則は 0001 と同じ（1 回の exec で完結、transaction 制御・PRAGMA を含めない）。
 */
export const sql = `
CREATE TABLE memory_exclusion (
	principal TEXT NOT NULL,
	scope_key TEXT NOT NULL,
	target_type TEXT NOT NULL CHECK (target_type IN ('state_item', 'candidate')),
	target_id TEXT NOT NULL,
	journal_seq INTEGER NOT NULL,
	seq INTEGER NOT NULL,
	PRIMARY KEY (principal, scope_key, target_type, target_id)
) WITHOUT ROWID;

CREATE TABLE memory_suppression (
	principal TEXT NOT NULL,
	scope_key TEXT NOT NULL,
	target_type TEXT NOT NULL CHECK (target_type IN ('state_item', 'state_fact')),
	target_id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	at_ms INTEGER NOT NULL,
	PRIMARY KEY (principal, scope_key, target_type, target_id)
) WITHOUT ROWID;

ALTER TABLE memory_state_item
	ADD COLUMN strength REAL NOT NULL DEFAULT 1.0 CHECK (strength >= 0.0 AND strength <= 1.0);

ALTER TABLE memory_change ADD COLUMN source_run_id TEXT;
ALTER TABLE memory_change ADD COLUMN change_kind TEXT
	CHECK (change_kind IS NULL OR change_kind IN ('correction', 'consolidation', 'excluded', 'exclusion_released', 'suppressed', 'suppression_released', 'promoted'));
ALTER TABLE memory_change ADD COLUMN successor_id TEXT;

CREATE TABLE memory_inferred_candidate (
	candidate_id TEXT PRIMARY KEY,
	principal TEXT NOT NULL,
	scope_key TEXT NOT NULL,
	kind TEXT NOT NULL
		CHECK (kind IN ('preference', 'personal_fact', 'constraint', 'habit', 'other_person_note')),
	subject TEXT NOT NULL,
	semantic_key TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('open', 'dismissed', 'promoted', 'forgotten')),
	value_text TEXT,
	polarity TEXT CHECK (polarity IS NULL OR polarity IN ('affirmed', 'negated')),
	origin TEXT NOT NULL CHECK (origin = 'agent_inferred'),
	evidence_ordinal INTEGER NOT NULL CHECK (evidence_ordinal >= 0),
	promoted_item_id TEXT,
	promoted_run_id TEXT,
	created_seq INTEGER NOT NULL,
	updated_seq INTEGER NOT NULL,
	CHECK ((kind = 'other_person_note') = (subject LIKE 'other:%')),
	CHECK (subject = 'self' OR subject LIKE 'other:%'),
	CHECK (status = 'forgotten' OR (value_text IS NOT NULL AND polarity IS NOT NULL)),
	CHECK (status <> 'promoted' OR promoted_item_id IS NOT NULL)
);
CREATE INDEX memory_inferred_candidate_by_scope
	ON memory_inferred_candidate (principal, scope_key, status, updated_seq);
CREATE UNIQUE INDEX memory_inferred_candidate_one_open
	ON memory_inferred_candidate (principal, scope_key, subject, kind, semantic_key, polarity, value_text)
	WHERE status = 'open';

CREATE TRIGGER memory_inferred_candidate_no_resurrection
BEFORE INSERT ON memory_inferred_candidate
WHEN EXISTS (
	SELECT 1 FROM memory_tombstone
	WHERE target_type = 'candidate' AND target_id = NEW.candidate_id
)
BEGIN
	SELECT RAISE(ABORT, 'memory_tombstoned');
END;

CREATE TABLE memory_inferred_candidate_evidence (
	candidate_id TEXT NOT NULL REFERENCES memory_inferred_candidate (candidate_id),
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
	conversation_id TEXT,
	observed_ms INTEGER NOT NULL,
	PRIMARY KEY (candidate_id, idx),
	UNIQUE (candidate_id, source_key, start_byte, end_byte),
	CHECK (start_byte >= 0 AND end_byte > start_byte)
);
`;
