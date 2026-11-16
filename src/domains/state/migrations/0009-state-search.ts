/**
 * State の全文検索の索引（設計 `spec/state-search-design.md` §3.3、決定 1・4）。
 * active な item の semantic_key・value_text・属性だけを、FTS5 の trigram で索引にする（引用は入れない）。
 * 通常の（本文を持つ）FTS5 表に `secure-delete=1` を設定し、削除は trigger で必ず行う（安全側）。
 * 追加は核の書き込み関数が同じ transaction の中で行う（`syncStateSearch`）。初回は既存の active な item を全件登録する。
 */
export const sql = `
CREATE TABLE memory_state_search_row (
	search_rowid INTEGER PRIMARY KEY,
	item_id TEXT NOT NULL UNIQUE REFERENCES memory_state_item (item_id)
);
CREATE VIEW memory_state_search_doc AS
SELECT i.item_id, i.principal, i.scope_key,
	i.semantic_key || char(10) || i.value_text || coalesce(char(10) || (
		SELECT group_concat(a.attr_key || ' ' || a.attr_value, char(10) ORDER BY a.attr_key)
		FROM memory_state_attribute a WHERE a.item_id = i.item_id), '') AS doc
FROM memory_state_item i WHERE i.status = 'active';
CREATE VIRTUAL TABLE memory_state_fts USING fts5(doc, tokenize = 'trigram case_sensitive 0');
INSERT INTO memory_state_fts (memory_state_fts, rank) VALUES ('secure-delete', 1);
CREATE TRIGGER memory_state_search_item_update
AFTER UPDATE OF status, value_text, semantic_key ON memory_state_item
BEGIN
	DELETE FROM memory_state_fts WHERE rowid =
		(SELECT search_rowid FROM memory_state_search_row WHERE item_id = NEW.item_id);
	DELETE FROM memory_state_search_row WHERE item_id = NEW.item_id AND NEW.status <> 'active';
END;
CREATE TRIGGER memory_state_search_attribute_insert
AFTER INSERT ON memory_state_attribute
BEGIN
	DELETE FROM memory_state_fts WHERE rowid =
		(SELECT search_rowid FROM memory_state_search_row WHERE item_id = NEW.item_id);
END;
CREATE TRIGGER memory_state_search_attribute_delete
AFTER DELETE ON memory_state_attribute
BEGIN
	DELETE FROM memory_state_fts WHERE rowid =
		(SELECT search_rowid FROM memory_state_search_row WHERE item_id = OLD.item_id);
END;
CREATE TRIGGER memory_state_search_item_delete
BEFORE DELETE ON memory_state_item
BEGIN
	DELETE FROM memory_state_fts WHERE rowid =
		(SELECT search_rowid FROM memory_state_search_row WHERE item_id = OLD.item_id);
	DELETE FROM memory_state_search_row WHERE item_id = OLD.item_id;
END;
INSERT INTO memory_state_search_row (item_id) SELECT item_id FROM memory_state_search_doc;
INSERT INTO memory_state_fts (rowid, doc)
	SELECT r.search_rowid, d.doc FROM memory_state_search_doc d
	JOIN memory_state_search_row r ON r.item_id = d.item_id;
`;
