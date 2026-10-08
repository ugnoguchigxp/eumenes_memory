/**
 * 0002 records（S1 + S2）: 外部取得物の本文・版・全文索引。
 *
 * 規則は 0001 と同じ（1 回の exec で完結、PRAGMA・ホスト表への DDL/FK を含めない）。列挙の CHECK は
 * `src/contracts/records.ts` のタプルと一致させる（`src/store/test/records-migration.test.ts` で照合）。
 * trigger の本体は SQL の都合で begin ... end が要る。`src/store` の hygiene 検査（大文字の予約語を探す）に
 * 当たらないよう、このファイルの SQL は小文字で書き、`begin` は行頭に置かない（`when exists (...) begin`）。
 *
 * - memory_record: 1 origin = 1 行。status は active / inactive / forgotten。forgotten の行は origin 等を空にした
 *   殻（墓標と二重化して読み出しから除外する）。record_id は principal / scope / origin の hash なので、別 scope の
 *   同じ origin は別の record になる。
 * - memory_record_revision / memory_record_body: revision ごとの本文。forget は全 revision を消す。
 * - memory_record_fts: 現在 revision の本文だけの全文索引（contentless、trigram、大文字小文字を区別する設定で、
 *   アプリが ASCII を小文字へ畳んだ本文を入れる。LIKE 戦略と結果を一致させるため）。rowid = body の rowid。
 *   trigger ではなくアプリコードで維持する（forget を同一関数で完結させるため）。
 * - memory_record_provider: 外部プロバイダーへ送った取得物の記録。forget の外部削除確認（pending）の元になる。
 * - trigger memory_record_no_resurrection 系: 墓標のある record_id への挿入を拒否する最終防衛線。
 */
export const sql = `
CREATE TABLE memory_record (
	record_id TEXT PRIMARY KEY,
	principal TEXT NOT NULL,
	scope_key TEXT NOT NULL,
	origin_namespace TEXT NOT NULL,
	origin_kind TEXT NOT NULL,
	origin_id TEXT NOT NULL,
	media_type TEXT NOT NULL
		CHECK (media_type IN ('text/plain', 'text/markdown', 'application/json')),
	capture_state TEXT NOT NULL CHECK (capture_state IN ('complete', 'partial')),
	status TEXT NOT NULL CHECK (status IN ('active', 'inactive', 'forgotten')),
	current_revision TEXT NOT NULL,
	created_seq INTEGER NOT NULL,
	updated_seq INTEGER NOT NULL
);
CREATE INDEX memory_record_by_scope ON memory_record (principal, scope_key, status);

CREATE TABLE memory_record_body (
	rowid INTEGER PRIMARY KEY,
	record_id TEXT NOT NULL,
	revision TEXT NOT NULL,
	representation TEXT NOT NULL CHECK (representation IN ('text')),
	content TEXT NOT NULL
);
CREATE UNIQUE INDEX memory_record_body_by_revision
	ON memory_record_body (record_id, revision);

CREATE TABLE memory_record_revision (
	record_id TEXT NOT NULL,
	revision TEXT NOT NULL,
	digest TEXT NOT NULL,
	byte_length INTEGER NOT NULL,
	body_rowid INTEGER NOT NULL,
	seq INTEGER NOT NULL,
	PRIMARY KEY (record_id, revision)
);

CREATE TABLE memory_record_provider (
	record_id TEXT NOT NULL,
	provider_ref TEXT NOT NULL,
	PRIMARY KEY (record_id, provider_ref)
);

CREATE VIRTUAL TABLE memory_record_fts USING fts5(
	body,
	content = '',
	contentless_delete = 1,
	tokenize = 'trigram case_sensitive 1'
);

create trigger memory_record_no_resurrection before insert on memory_record
when exists (
	select 1 from memory_tombstone t
	where t.target_type = 'record' and t.target_id = new.record_id
) begin
	select raise(abort, 'memory_tombstoned');
end;

create trigger memory_record_body_no_resurrection before insert on memory_record_body
when exists (
	select 1 from memory_tombstone t
	where t.target_type = 'record' and t.target_id = new.record_id
) begin
	select raise(abort, 'memory_tombstoned');
end;

create trigger memory_record_revision_no_resurrection before insert on memory_record_revision
when exists (
	select 1 from memory_tombstone t
	where t.target_type = 'record' and t.target_id = new.record_id
) begin
	select raise(abort, 'memory_tombstoned');
end;
`;
