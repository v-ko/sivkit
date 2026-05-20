"""Hash parity test — Python side.

Loads a fixture JSON, inserts entities into an InMemoryStore,
builds a HashTree, and prints the root hash.

If the fixture contains "deltas", applies each one sequentially via
update_hash_tree and prints the final root hash after all deltas.

Usage:
    python test-parity-py.py [fixture.json]

Defaults to fixtures/fuzz-42.json if no argument given.
"""

import json
import sys
from pathlib import Path

import attrs

from fusion.libs.model import Entity, entity_type, load_from_dict
from fusion.storage.delta import Delta
from fusion.storage.hash_tree import build_hash_tree, update_hash_tree
from fusion.storage.in_memory_store import InMemoryStore

# ── Test entity types (minimal, matching the fixture schema) ──


@entity_type
class TestPage(Entity):
    name: str = ""


@entity_type
class TestNote(Entity):
    x: float = 0.0
    y: float = 0.0
    width: float = 0.0
    height: float = 0.0
    content: str = ""
    color: list = attrs.Factory(list)
    tags: list = attrs.Factory(list)


# ── Main ──


def main():
    here = Path(__file__).parent
    fixture_path = (
        Path(sys.argv[1]) if len(sys.argv) > 1 else here / "fixtures" / "fuzz-42.json"
    )

    fixture = json.loads(fixture_path.read_text())
    entities_data = fixture["entities"]

    store = InMemoryStore()
    for entity_dict in entities_data:
        entity = load_from_dict(dict(entity_dict))  # copy to avoid pop-mutation
        store.insert_one(entity)

    tree = build_hash_tree(store)
    root_hash = tree.root_hash()

    print(f"Entities: {len(entities_data)}")
    print(f"Build root hash: {root_hash}")

    # Apply deltas if present (tests update_hash_tree)
    deltas = fixture.get("deltas", [])
    if deltas:
        print(f"\nApplying {len(deltas)} deltas...")
        for i, delta_data in enumerate(deltas):
            delta = Delta.from_data(delta_data)
            store.apply_delta(delta)
            update_hash_tree(tree, store, delta)

        final_hash = tree.root_hash()
        print(f"Final root hash (after deltas): {final_hash}")

        # Verify incremental update matches full rebuild
        rebuilt_tree = build_hash_tree(store)
        rebuilt_hash = rebuilt_tree.root_hash()
        if final_hash == rebuilt_hash:
            print("PASS: incremental update matches full rebuild")
        else:
            print(f"FAIL: incremental={final_hash} vs rebuild={rebuilt_hash}")
            sys.exit(1)

        # Use final hash as the output for cross-language comparison
        root_hash = final_hash

    print(f"\nRoot hash: {root_hash}")
    return root_hash


if __name__ == "__main__":
    main()
