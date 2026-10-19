/**
 * Portable name parity run, TypeScript side. Same output as parity-py.py.
 *
 * Usage:
 *     node parity-ts.mts inputs.json > ts.txt
 */

import { readFileSync, writeSync } from "node:fs";

import { canonicalKey, checkPortableName, checkPortablePath } from "../../typescript/src/util/portablePath.ts";

function hexKey(text: string): string {
    return Array.from(canonicalKey(text), ch => ch.codePointAt(0)!.toString(16)).join(" ");
}

const inputs: string[] = JSON.parse(readFileSync(process.argv[2], "utf-8"));
const lines: string[] = [];
const flush = () => {
    writeSync(1, lines.join(""));
    lines.length = 0;
};

for (let cp = 0; cp < 0x110000; cp++) {
    const ch = String.fromCodePoint(cp);
    const label = `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
    if (/\p{Cn}/u.test(ch)) {
        lines.push(`${label}\tunassigned\n`);
        continue;
    }
    const name = checkPortableName(ch) ?? "ok";
    const inName = checkPortableName(`a${ch}b`) ?? "ok";
    lines.push(`${label}\t${name}\t${inName}\t${hexKey(ch)}\n`);
    if (lines.length >= 10000) flush();
}
inputs.forEach((text, i) => {
    const name = checkPortableName(text) ?? "ok";
    const path = checkPortablePath(text) ?? "ok";
    lines.push(`${i}\t${name}\t${path}\t${hexKey(text)}\n`);
});
flush();
