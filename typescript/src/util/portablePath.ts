// Portable file names: valid on Linux, macOS and Windows. The Python twin is
// sivkit/storage/fs/names.py; tests/portable-names/run.sh checks that both agree.

export const MAX_PART_BYTES = 255;
export const MAX_PATH_BYTES = 1024;
export const MAX_DEPTH = 32;

const FORBIDDEN_CHARS = /[\\<>:"|?*]/;
// ZWNJ and ZWJ are allowed (emoji sequences)
const REFUSED_CHARS = /(?![\u200C\u200D])[\p{Cc}\p{Cf}\p{Cs}]/u;
const RESERVED_STEMS = new Set([
    'CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$',
    ...['COM', 'LPT'].flatMap(device => [...'0123456789¹²³'].map(n => device + n)),
]);

const encoder = new TextEncoder();

function partReason(part: string): string | null {
    if (part === '') return 'empty';
    if (part === '.' || part === '..') return 'dot';
    if (encoder.encode(part).length > MAX_PART_BYTES) return 'part_length';
    if (part !== part.normalize('NFC')) return 'not_nfc';
    if (FORBIDDEN_CHARS.test(part)) return 'char';
    if (REFUSED_CHARS.test(part)) return 'control';
    if (part.endsWith('.') || part.endsWith(' ')) return 'trailing';
    // Windows ignores spaces before the extension: `CON .txt` is the device too
    if (RESERVED_STEMS.has(part.split('.', 1)[0].replace(/ +$/, '').toUpperCase())) return 'reserved';
    return null;
}

/** The reason `name` isn't a portable single path part, or null. */
export function checkPortableName(name: string): string | null {
    if (name.includes('/')) return 'char';
    return partReason(name);
}

/** The reason `rel` isn't a portable relative `/`-separated path, or null. */
export function checkPortablePath(rel: string): string | null {
    if (rel === '') return 'empty';
    if (rel.startsWith('/')) return 'absolute';
    if (encoder.encode(rel).length > MAX_PATH_BYTES) return 'path_length';
    const parts = rel.split('/');
    if (parts.length > MAX_DEPTH) return 'depth';
    for (const part of parts) {
        const reason = partReason(part);
        if (reason) return reason;
    }
    return null;
}

/** The key under which case-insensitive file systems see `rel` as one name;
 * equal to the Python `canonical_key`. */
export function canonicalKey(rel: string): string {
    return rel.normalize('NFC').toLowerCase().toUpperCase().toLowerCase().normalize('NFC');
}
