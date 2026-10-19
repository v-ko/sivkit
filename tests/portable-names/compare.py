"""Compare the Python and TypeScript parity outputs.

Code points that either runtime's Unicode data doesn't assign are skipped.
Any other difference fails.

Usage:
    python compare.py inputs.json py.txt ts.txt
"""

import json
import sys
from pathlib import Path

MAX_SHOWN = 20


def main():
    inputs = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    py_lines = Path(sys.argv[2]).read_text(encoding="utf-8").splitlines()
    ts_lines = Path(sys.argv[3]).read_text(encoding="utf-8").splitlines()
    if len(py_lines) != len(ts_lines):
        print(f"FAIL: {len(py_lines)} Python lines, {len(ts_lines)} TypeScript lines")
        sys.exit(1)

    skipped = 0
    failures = []
    for py, ts in zip(py_lines, ts_lines):
        if py == ts:
            continue
        label = py.split("\t", 1)[0]
        if label.startswith("U+"):
            if py.endswith("\tunassigned") or ts.endswith("\tunassigned"):
                skipped += 1
                continue
        else:
            label = repr(inputs[int(label)])
        failures.append((label, py, ts))

    print(f"{len(py_lines)} lines compared")
    print(f"{skipped} code points skipped: unassigned in one runtime")
    for label, py, ts in failures[:MAX_SHOWN]:
        print(f"{label}\n  py: {py}\n  ts: {ts}")
    if failures:
        print(f"FAIL: {len(failures)} differences")
        sys.exit(1)
    print("PASS")


if __name__ == "__main__":
    main()
