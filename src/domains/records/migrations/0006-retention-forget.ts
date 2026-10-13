/** Forgotten Records retain tombstones, but never remain in the regenerable cache inventory. */
export const sql = `
DELETE FROM memory_record_retention WHERE record_id IN (
	SELECT record_id FROM memory_record WHERE status='forgotten'
);
CREATE TRIGGER memory_retention_forget
AFTER UPDATE OF status ON memory_record WHEN NEW.status='forgotten'
BEGIN
	DELETE FROM memory_record_retention WHERE record_id=NEW.record_id;
END;
`;
