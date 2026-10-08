/** エンコードせずコード単位から UTF-8 byte 長を計算する。 */
export function utf8ByteLength(s: string): number {
	let bytes = 0;
	for (let i = 0; i < s.length; i += 1) {
		const c = s.charCodeAt(i);
		if (c < 0x80) {
			bytes += 1;
		} else if (c < 0x800) {
			bytes += 2;
		} else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
			const next = s.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				i += 1;
			} else {
				bytes += 3;
			}
		} else {
			bytes += 3;
		}
	}
	return bytes;
}

export function encodeUtf8(s: string): Uint8Array {
	return new TextEncoder().encode(s);
}

/** lone surrogate を含まない場合に true。String.prototype.isWellFormed に依存しない。 */
export function isWellFormedUtf16(s: string): boolean {
	for (let i = 0; i < s.length; i += 1) {
		const c = s.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff) {
			const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
			if (next < 0xdc00 || next > 0xdfff) return false;
			i += 1;
		} else if (c >= 0xdc00 && c <= 0xdfff) {
			return false;
		}
	}
	return true;
}

/** UTF-8 コードポイント境界か。書記素クラスタは考慮しない。 */
export function isUtf8CharBoundary(bytes: Uint8Array, index: number): boolean {
	if (!Number.isSafeInteger(index) || index < 0 || index > bytes.length) {
		return false;
	}
	if (index === 0 || index === bytes.length) return true;
	const byte = bytes[index];
	return byte !== undefined && (byte & 0xc0) !== 0x80;
}
