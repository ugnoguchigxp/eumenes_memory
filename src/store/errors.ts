export const STORE_ERROR_CODES = Object.freeze([
	/** 書き込み系を transaction の外で呼んだ。 */
	"NOT_IN_TRANSACTION",
	/** 書き込み系に読み取り専用接続を渡した。 */
	"READONLY_CONNECTION",
	/** `memory_schema_info` が無い（migration 未適用）。 */
	"SCHEMA_MISSING",
	/** DB の migration の中身がこの本体と一致しない（hash 不一致、版の欠落）。 */
	"SCHEMA_MISMATCH",
	/** DB の版が本体の既知の版より新しい（古い本体が新しい DB に接続した）。 */
	"SCHEMA_TOO_NEW",
	/** DB の版が本体の既知の版より古い（ホストが最新の migration を適用していない）。 */
	"SCHEMA_OUTDATED",
	/** 行の列が欠けている・型が違う。 */
	"CORRUPT_ROW",
	/** 墓標のある ID への再挿入（trigger の最終防衛線。通常は事前検査で blocked を返す）。 */
	"TOMBSTONED",
	/** applyForget に渡された entry がジャーナルの連鎖／DB の記録と合わない。 */
	"JOURNAL_ENTRY_INVALID",
	/** `fts5` が使えない環境（検索は LIKE のみになる）。 */
	"FTS_UNAVAILABLE",
	/** 契約は確定しているが実装が後続スライスの担当（S0 の stub）。 */
	"NOT_IMPLEMENTED",
] as const);

export type StoreErrorCode = (typeof STORE_ERROR_CODES)[number];

/**
 * 永続 API のエラー。message は `code` 固定で、本文・ID・SQL を含めない。
 * 入力検査違反は従来どおり `MemoryContractError` で、こちらは使わない。
 */
export class MemoryStoreError extends Error {
	override readonly name = "MemoryStoreError" as const;
	readonly code: StoreErrorCode;

	constructor(code: StoreErrorCode) {
		super(code);
		this.code = code;
	}
}

/** instanceof に加え、複数コピーのパッケージでも判定できるよう構造でも判定する。 */
export function isMemoryStoreError(value: unknown): value is MemoryStoreError {
	if (value instanceof MemoryStoreError) return true;
	if (!(value instanceof Error)) return false;
	const candidate = value as unknown as Record<string, unknown>;
	return (
		candidate["name"] === "MemoryStoreError" &&
		typeof candidate["code"] === "string" &&
		(STORE_ERROR_CODES as readonly string[]).includes(candidate["code"])
	);
}

/** S0 の stub 用。契約（型）は確定しているが、実装は担当スライスが置き換える。 */
export function notImplemented(): never {
	throw new MemoryStoreError("NOT_IMPLEMENTED");
}
