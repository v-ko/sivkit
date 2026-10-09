#!/usr/bin/env bash
# Run the hash parity test: Python vs TypeScript.
# Generates a fuzz fixture or uses an existing one, and runs both languages.
# Exit 0 if all fixture checks pass and checkpoint/root hashes match, 1 otherwise.
#
# Usage:
#   bash run.sh                     # Generate fuzz (seed=42) and test
#   bash run.sh --seed 123          # Custom seed
#   bash run.sh /path/to/fixture.json  # Use an existing fixture

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PYTHON="${PYTHON:-python}"
SEED=42
FIXTURE=""

# Parse args
while [[ $# -gt 0 ]]; do
    case "$1" in
        --seed) SEED="$2"; shift 2;;
        *) FIXTURE="$1"; shift;;
    esac
done

# Generate fixture if none provided
if [ -z "$FIXTURE" ]; then
    FIXTURE="$HERE/fixtures/fuzz-${SEED}.json"
    echo "Generating fuzz fixture (seed=$SEED)..."
    $PYTHON "$HERE/generate-fixture.py" --fuzz --seed "$SEED" --count 10000 --deltas 2000 > "$FIXTURE"
fi

echo "=== Hash Parity Test ==="
echo "Fixture: $FIXTURE"
echo

# Python side
echo "--- Python ---"
PY_STATUS=0
PY_OUTPUT=$($PYTHON "$HERE/test-parity-py.py" "$FIXTURE") || PY_STATUS=$?
echo "$PY_OUTPUT"
echo

# TypeScript side
echo "--- TypeScript ---"
TS_STATUS=0
TS_OUTPUT=$(cd "$HERE/../.." && npx --yes tsx "$HERE/test-parity-ts.ts" "$FIXTURE") || TS_STATUS=$?
echo "$TS_OUTPUT"
echo

# Compare
echo "=== Result ==="
if [ "$PY_STATUS" -ne 0 ] || [ "$TS_STATUS" -ne 0 ]; then
    echo "FAIL: fixture checks failed (Python=$PY_STATUS, TypeScript=$TS_STATUS)"
    exit 1
fi
PY_HASHES=$(echo "$PY_OUTPUT" | grep -E '^(Checkpoint hash:|Root hash:)')
TS_HASHES=$(echo "$TS_OUTPUT" | grep -E '^(Checkpoint hash:|Root hash:)')
if [ "$PY_HASHES" = "$TS_HASHES" ]; then
    echo "PASS: PY and TS checkpoint and root hashes match"
    exit 0
else
    echo "FAIL: checkpoint or root hashes differ!"
    echo "Python:"
    echo "$PY_HASHES"
    echo "TypeScript:"
    echo "$TS_HASHES"
    exit 1
fi
