"""Portable file names: names that are valid on Linux, macOS and Windows.

The rules apply on every platform, so a project written on Linux stays readable
when synced to Windows. The TypeScript twin is `typescript/src/util/portablePath.ts`;
`tests/portable-names/run.sh` checks that both give the same results.
"""

import re
import unicodedata

MAX_PART_BYTES = 255
MAX_PATH_BYTES = 1024
MAX_DEPTH = 32

_FORBIDDEN_CHARS = re.compile(r'[\\<>:"|?*]')
_ALLOWED_FORMAT_CHARS = {"\u200c", "\u200d"}  # ZWNJ, ZWJ (emoji sequences)
_REFUSED_CATEGORIES = {"Cc", "Cf", "Cs"}
_RESERVED_STEMS = frozenset(
    ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"]
    + [f"{device}{n}" for device in ("COM", "LPT") for n in "0123456789¹²³"]
)


class UnsafeName(ValueError):
    """A name or relative path that isn't portable. `reason` is a short code."""

    def __init__(self, path: str, reason: str):
        super().__init__(f"Unsafe name {path!r}: {reason}")
        self.path = path
        self.reason = reason


def _utf8_len(text: str) -> int:
    return len(text.encode("utf-8", "surrogatepass"))


def _part_reason(part: str) -> str | None:
    if part == "":
        return "empty"
    if part in (".", ".."):
        return "dot"
    if _utf8_len(part) > MAX_PART_BYTES:
        return "part_length"
    if not unicodedata.is_normalized("NFC", part):
        return "not_nfc"
    if _FORBIDDEN_CHARS.search(part):
        return "char"
    for ch in part:
        if (
            unicodedata.category(ch) in _REFUSED_CATEGORIES
            and ch not in _ALLOWED_FORMAT_CHARS
        ):
            return "control"
    if part[-1] in ". ":
        return "trailing"
    # Windows ignores spaces before the extension: `CON .txt` is the device too
    if part.split(".", 1)[0].rstrip(" ").upper() in _RESERVED_STEMS:
        return "reserved"
    return None


def check_portable_name(name: str) -> None:
    """Raises `UnsafeName` unless `name` is a portable single path part."""
    if "/" in name:
        raise UnsafeName(name, "char")
    reason = _part_reason(name)
    if reason:
        raise UnsafeName(name, reason)


def check_portable_path(rel: str) -> None:
    """Raises `UnsafeName` unless `rel` is a portable relative `/`-separated path."""
    if rel == "":
        raise UnsafeName(rel, "empty")
    if rel.startswith("/"):
        raise UnsafeName(rel, "absolute")
    if _utf8_len(rel) > MAX_PATH_BYTES:
        raise UnsafeName(rel, "path_length")
    parts = rel.split("/")
    if len(parts) > MAX_DEPTH:
        raise UnsafeName(rel, "depth")
    for part in parts:
        reason = _part_reason(part)
        if reason:
            raise UnsafeName(rel, reason)


def canonical_key(rel: str) -> str:
    """The key under which case-insensitive file systems see `rel` as one name.

    NFC, lower, upper, lower, NFC: the TypeScript twin gives the same string
    (`casefold()` has no JS equivalent), and `ẞ`, `ß` and `ss` share one key.
    It also folds `ς` with `σ`, as NTFS and APFS do, and `ß` with `ss`, which
    they don't (a harmless extra refusal).
    """
    return unicodedata.normalize(
        "NFC", unicodedata.normalize("NFC", rel).lower().upper().lower()
    )
