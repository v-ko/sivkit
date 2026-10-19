"""Generate inputs for the portable name parity run.

Writes a JSON list of strings: the curated cases, names and paths at the
length limits, and every ordered pair of tokens that exercise the rules.

Usage:
    python generate-inputs.py > inputs.json
"""

import json
from itertools import product
from pathlib import Path

TOKENS = [
    # Plain text
    *"aZ09-_ ()'.",
    "notes",
    "canvas.html",
    "\u4e2d",
    "\u0434",
    # Separators and forbidden characters
    *'/\\<>:"|?*',
    # Controls and format characters
    "\x00",
    "\x1f",
    "\x7f",
    "\t",
    "\u0085",
    "\u200b",
    "\u200c",
    "\u200d",
    "\u200e",
    "\u202e",
    "\u2060",
    "\ufeff",
    "\ud800",
    "\udc00",
    # Combining marks and pieces that compose
    "e",
    "\u0301",
    "\u0323",
    "\u0307",
    "\u0308",
    "\u0327",
    "\u00e9",
    "\u00c5",
    "\u212b",
    "\u1100",
    "\u1161",
    "\u11a8",
    "\u0915",
    "\u094d",
    "\u0937",
    # Characters with special case mappings
    "\u00df",
    "\u1e9e",
    "\u0130",
    "\u0131",
    "\u03a3",
    "\u03c3",
    "\u03c2",
    "\ufb01",
    "\u0149",
    "\u01f0",
    "\u0390",
    "\u01c5",
    "\uab70",
    "\u13a0",
    # Reserved stems and their parts
    "CON",
    "con",
    "PRN",
    "AUX",
    "NUL",
    "COM",
    "LPT",
    "1",
    "\u00b9",
    "\u2074",
    "CONIN$",
    "CONOUT$",
    "$",
    "\u00a0",
    "\u3000",
    # Emoji and spaces
    "\U0001f469",
    "\U0001f4bb",
    "\ufe0f",
    "\U0001f3fd",
]


def length_cases() -> list[str]:
    part = "a" * 255
    return [
        part,
        "a" * 256,
        "\u00e9" * 127 + "a",
        "\u00e9" * 128,
        "\U0001f600" * 63 + "abc",
        "\U0001f600" * 64,
        "/".join([part] * 4),
        "/".join([part] * 4) + "/a",
        "/".join([part] * 4) + "/",
    ]


def main():
    curated = json.loads(
        (Path(__file__).parent / "curated.json").read_text(encoding="utf-8")
    )
    inputs = [s for group in curated.values() for s in group]
    inputs += length_cases()
    inputs += [a + b for a, b in product(TOKENS, repeat=2)]
    print(json.dumps(inputs))


if __name__ == "__main__":
    main()
