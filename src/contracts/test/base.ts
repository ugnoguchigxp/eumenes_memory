import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BUILD_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"fixtures",
	"build",
);

/** テスト用の素材。fixture B01 の入力を毎回新しく読み込む（JSON 値として可変）。 */
export function baseInput(): any {
	const fixture = JSON.parse(
		readFileSync(join(BUILD_DIR, "B01-ready-basic.json"), "utf8"),
	);
	return fixture.input;
}

export function baseView(): any {
	const fixture = JSON.parse(
		readFileSync(join(BUILD_DIR, "B01-ready-basic.json"), "utf8"),
	);
	return fixture.expect.result;
}

/** UTF-8 でちょうど bytes byte の文字列（3 byte 文字と ASCII の混在）。 */
export function exactBytes(bytes: number): string {
	const wide = Math.floor(bytes / 3) - 1;
	return "あ".repeat(wide) + "a".repeat(bytes - wide * 3);
}
