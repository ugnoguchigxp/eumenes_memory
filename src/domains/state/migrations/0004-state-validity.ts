/**
 * State item の成立期間の精度と根拠。
 * `valid_from_ms` / `valid_until_ms` は従来どおり期間の境界（until は含まない）を持ち、ここは精度つきの日付
 * （`2026` / `2026-09` / `2026-09-03`）と根拠だけを足す。精度のない行は NULL のまま。forget は 3 列とも NULL にする。
 */
export const sql = `
ALTER TABLE memory_state_item ADD COLUMN valid_from_text TEXT;
ALTER TABLE memory_state_item ADD COLUMN valid_until_text TEXT;
ALTER TABLE memory_state_item ADD COLUMN valid_basis TEXT
	CHECK (valid_basis IS NULL OR valid_basis IN ('stated', 'inferred', 'unknown'));
`;
