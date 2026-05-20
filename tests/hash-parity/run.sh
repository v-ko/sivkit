#!/usr/bin/env bash
# Run the hash parity test: Python vs TypeScript.
# Generates a fuzz fixture, runs both sides, compares root hashes.
# Exit 0 if they match, 1 if they differ.
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
PY_OUTPUT=$($PYTHON "$HERE/test-parity-py.py" "$FIXTURE")
echo "$PY_OUTPUT"
PY_HASH=$(echo "$PY_OUTPUT" | grep "^Root hash:" | tail -1 | cut -d' ' -f3)
echo

# TypeScript side
echo "--- TypeScript ---"
TS_OUTPUT=$(cd "$HERE/../.." && npx --yes tsx "$HERE/test-parity-ts.ts" "$FIXTURE")
echo "$TS_OUTPUT"
TS_HASH=$(echo "$TS_OUTPUT" | grep "^Root hash:" | tail -1 | cut -d' ' -f3)
echo

# Compare
echo "=== Result ==="
if [ "$PY_HASH" = "$TS_HASH" ]; then
    echo "PASS: PY and TS root hashes match: $PY_HASH"
    exit 0
else
    echo "FAIL: root hashes differ!"
    echo "  Python: $PY_HASH"
    echo "  TS:     $TS_HASH"
    exit 1
fi
