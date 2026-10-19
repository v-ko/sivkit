#!/usr/bin/env bash
# Run the portable name parity check: Python vs TypeScript.
# Both sides check every code point and the generated inputs; outputs must match.
#
# Usage:
#   PYTHON=../dev_venv/bin/python bash run.sh

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PYTHON="${PYTHON:-python}"

OUT="$HERE/out"
mkdir -p "$OUT"
$PYTHON "$HERE/generate-inputs.py" > "$OUT/inputs.json"
$PYTHON "$HERE/parity-py.py" "$OUT/inputs.json" > "$OUT/py.txt"
node "$HERE/parity-ts.mts" "$OUT/inputs.json" > "$OUT/ts.txt"
$PYTHON "$HERE/compare.py" "$OUT/inputs.json" "$OUT/py.txt" "$OUT/ts.txt"
