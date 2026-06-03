/**
 * RFC 8785 JSON Canonicalization Scheme (JCS) implementation.
 *
 * Produces deterministic JSON output with sorted keys and compact
 * separators. On JS, JSON.stringify already formats numbers per
 * ES6 Number.toString(), so no special number handling is needed.
 *
 * This matches the Python canonical_json() in sivkit/libs/canonical_json.py.
 */

export function canonicalJson(obj: unknown): string {
    if (obj === null || obj === undefined) {
        return "null";
    }
    if (typeof obj === "boolean") {
        return obj ? "true" : "false";
    }
    if (typeof obj === "string") {
        return JSON.stringify(obj);
    }
    if (typeof obj === "number") {
        if (!isFinite(obj)) {
            throw new Error(`Invalid JSON number: ${obj}`);
        }
        // JSON.stringify handles -0 → "0" and follows ES6 Number.toString()
        return Object.is(obj, -0) ? "0" : JSON.stringify(obj);
    }
    if (Array.isArray(obj)) {
        const items = obj.map(v =>
            v === undefined ? "null" : canonicalJson(v)
        );
        return "[" + items.join(",") + "]";
    }
    if (typeof obj === "object") {
        const parts: string[] = [];
        for (const key of Object.keys(obj).sort()) {
            const val = (obj as Record<string, unknown>)[key];
            if (val === undefined) {
                continue;
            }
            parts.push(canonicalJson(key) + ":" + canonicalJson(val));
        }
        return "{" + parts.join(",") + "}";
    }
    throw new Error(`Object of type ${typeof obj} is not JSON serializable`);
}
