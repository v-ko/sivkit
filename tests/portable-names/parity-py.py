"""Portable name parity run, Python side.

Prints one line per code point, then one line per input:
the name verdict, the path verdict and the canonical key as hex code points.

Usage:
    python parity-py.py inputs.json > py.txt
"""

import json
import sys
import unicodedata
from pathlib import Path

from sivkit.storage.fs.names import (
    UnsafeName,
    canonical_key,
    check_portable_name,
    check_portable_path,
)


def verdict(check, text: str) -> str:
    try:
        check(text)
    except UnsafeName as e:
        return e.reason
    return "ok"


def hex_key(text: str) -> str:
    return " ".join(f"{ord(ch):x}" for ch in canonical_key(text))


def main():
    inputs = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    out = sys.stdout
    for cp in range(0x110000):
        ch = chr(cp)
        if unicodedata.category(ch) == "Cn":
            out.write(f"U+{cp:04X}\tunassigned\n")
            continue
        name = verdict(check_portable_name, ch)
        in_name = verdict(check_portable_name, f"a{ch}b")
        out.write(f"U+{cp:04X}\t{name}\t{in_name}\t{hex_key(ch)}\n")
    for i, text in enumerate(inputs):
        name = verdict(check_portable_name, text)
        path = verdict(check_portable_path, text)
        out.write(f"{i}\t{name}\t{path}\t{hex_key(text)}\n")


if __name__ == "__main__":
    main()
