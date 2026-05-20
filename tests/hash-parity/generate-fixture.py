"""Generate hash parity test fixtures.

Modes:
  --export <db_path>   Export entities from a SQLite VCS database
  --fuzz [--seed N]    Generate random entities + deltas for fuzz testing

The fuzz fixture exercises both buildHashTree (from initial entities) and
updateHashTree (from deltas applied sequentially). Deltas cover:
  - CREATE new entities
  - DELETE existing entities
  - UPDATE (field changes)
  - Reparenting (UPDATE that changes parent_id)
  - Delete-then-recreate same ID

Usage:
    python generate-fixture.py --export /path/to/vcs.db > fixtures/exported.json
    python generate-fixture.py --fuzz --seed 42 > fixtures/fuzz-42.json
"""

import argparse
import json
import random
import sys
from pathlib import Path

# ── Random value generators ──


def random_string(rng: random.Random, max_len: int = 50) -> str:
    """Generate a random unicode string exercising JSON serialization edge cases.

    Distribution weighted toward what matters for canonical JSON parity:
    - ASCII printable (common case)
    - Broad BMP (Latin-ext, Greek, Cyrillic, Arabic, CJK, etc.)
    - Astral plane (emoji, math symbols — tests 4-byte UTF-8)
    - JSON-mandatory escapes (control chars, quotes, backslash)
    """
    length = rng.randint(0, max_len)
    chars = []
    for _ in range(length):
        category = rng.random()
        if category < 0.50:
            # ASCII printable
            chars.append(chr(rng.randint(0x20, 0x7E)))
        elif category < 0.70:
            # Broad BMP (skip surrogates D800-DFFF)
            cp = rng.randint(0x00A0, 0xD7FF)
            chars.append(chr(cp))
        elif category < 0.80:
            # Astral plane (supplementary multilingual + symbols)
            chars.append(chr(rng.randint(0x10000, 0x1FFFF)))
        elif category < 0.90:
            # Control chars (must be \uXXXX escaped in JSON)
            chars.append(chr(rng.randint(0x00, 0x1F)))
        else:
            # JSON-tricky: quotes, backslash, line/paragraph separators
            chars.append(rng.choice(['"', "\\", "\u2028", "\u2029", "\u200b"]))
    return "".join(chars)


def random_number(rng: random.Random) -> float | int:
    """Generate a random number covering edge cases for serialization."""
    category = rng.random()
    if category < 0.15:
        return 0
    elif category < 0.3:
        return rng.randint(-10000, 10000)
    elif category < 0.5:
        return float(rng.randint(-1000, 1000))  # whole float
    elif category < 0.7:
        return rng.uniform(-1000, 1000)
    elif category < 0.85:
        return rng.uniform(-1, 1)  # small (precision edge)
    else:
        exp = rng.randint(15, 20)
        return rng.choice([-1, 1]) * rng.random() * (10**exp)


# ── Entity dict generators ──


def make_page(rng: random.Random, page_id: str, parent_id: str = "") -> dict:
    return {
        "type_name": "TestPage",
        "id": page_id,
        "parent_id": parent_id,
        "name": random_string(rng),
    }


def make_note(rng: random.Random, note_id: str, parent_id: str) -> dict:
    return {
        "type_name": "TestNote",
        "id": note_id,
        "parent_id": parent_id,
        "x": random_number(rng),
        "y": random_number(rng),
        "width": abs(random_number(rng)),
        "height": abs(random_number(rng)),
        "content": random_string(rng),
        "color": [rng.random() for _ in range(4)],
        "tags": [random_string(rng, max_len=20) for _ in range(rng.randint(0, 5))],
    }


# ── Delta/Change generation ──
# DeltaData format: {entity_id: [entity_id, reverse_component, forward_component]}
# reverse_component: state before (for CREATE: {}, for UPDATE: old fields, for DELETE: full entity)
# forward_component: state after (for CREATE: full entity, for UPDATE: new fields, for DELETE: {})


def make_create_change(entity_dict: dict) -> tuple[str, list]:
    """A CREATE change: reverse={}, forward=full entity (sans id/parent_id not needed in component)."""
    entity_id = entity_dict["id"]
    # forward component is the full entity state
    forward = dict(entity_dict)
    return entity_id, [entity_id, {}, forward]


def make_delete_change(entity_dict: dict) -> tuple[str, list]:
    """A DELETE change: reverse=full entity, forward={}."""
    entity_id = entity_dict["id"]
    reverse = dict(entity_dict)
    return entity_id, [entity_id, reverse, {}]


def make_update_change(
    entity_id: str, old_fields: dict, new_fields: dict
) -> tuple[str, list]:
    """An UPDATE change: reverse=old field values, forward=new field values."""
    return entity_id, [entity_id, old_fields, new_fields]


def generate_fuzz_fixture(seed: int, entity_count: int, delta_count: int) -> dict:
    """Generate a random fixture with initial entities + deltas testing all operation types.

    The fixture tests:
    - buildHashTree: from the initial entity set
    - updateHashTree: from each delta applied sequentially

    Tree shape variety:
    - Wide flat pages (many children under one root)
    - Deep chains (page → page → page with nested parent_ids)
    - Empty pages (pages with no children)
    - Single-child paths
    """
    rng = random.Random(seed)

    # --- Phase 1: Generate initial entities with varied tree shapes ---
    # Track state for delta generation
    entities_by_id: dict[str, dict] = {}
    page_ids: list[str] = []
    note_ids: list[str] = []
    next_page = 0
    next_note = 0

    # Root pages (wide)
    num_root_pages = max(2, entity_count // 10)
    for _ in range(num_root_pages):
        pid = f"page-{next_page:04d}"
        next_page += 1
        entity = make_page(rng, pid)
        entities_by_id[pid] = entity
        page_ids.append(pid)

    # Deep chain: nested pages under first root
    chain_depth = rng.randint(2, 4)
    parent = page_ids[0]
    for _ in range(chain_depth):
        pid = f"page-{next_page:04d}"
        next_page += 1
        entity = make_page(rng, pid, parent_id=parent)
        entities_by_id[pid] = entity
        page_ids.append(pid)
        parent = pid  # next page nests deeper

    # Leave one page intentionally empty (no children)
    empty_page_id = page_ids[-1]

    # Distribute notes across pages (some pages get many, some get few)
    remaining = entity_count - len(entities_by_id)
    for i in range(remaining):
        nid = f"note-{next_note:04d}"
        next_note += 1
        # Weighted: first page gets more (wide), deep chain gets some, others get few
        if i < remaining // 2:
            parent = page_ids[0]  # wide
        elif i < remaining * 3 // 4:
            parent = rng.choice(page_ids[1:-1]) if len(page_ids) > 2 else page_ids[0]
        else:
            # Skip the empty page intentionally
            parent = rng.choice([p for p in page_ids if p != empty_page_id])
        entity = make_note(rng, nid, parent)
        entities_by_id[nid] = entity
        note_ids.append(nid)

    initial_entities = list(entities_by_id.values())

    # --- Phase 2: Generate deltas with varied operations ---
    deltas: list[dict] = []
    deleted_ids: set[str] = set()  # track for delete-then-recreate

    for delta_idx in range(delta_count):
        delta_data: dict[str, list] = {}

        # Each delta has 1-4 changes with mixed operations
        num_changes = rng.randint(1, 4)
        ops_done = 0

        while ops_done < num_changes:
            op = rng.choices(
                ["create", "update", "delete", "reparent", "recreate"],
                weights=[30, 35, 15, 15, 5],
            )[0]

            # Skip entities already targeted in this delta (same key = overwrite)
            already_in_delta = set(delta_data.keys())

            if op == "create":
                # Create a new note under a random page
                nid = f"note-{next_note:04d}"
                next_note += 1
                parent = rng.choice(page_ids)
                entity = make_note(rng, nid, parent)
                entities_by_id[nid] = entity
                note_ids.append(nid)
                eid, change = make_create_change(entity)
                delta_data[eid] = change

            elif op == "update" and note_ids:
                # Update fields on an existing note
                alive_notes = [
                    n
                    for n in note_ids
                    if n not in deleted_ids and n not in already_in_delta
                ]
                if not alive_notes:
                    continue
                target_id = rng.choice(alive_notes)
                old_entity = entities_by_id[target_id]

                # Pick 1-3 fields to change
                updatable = ["x", "y", "width", "height", "content", "color", "tags"]
                fields_to_change = rng.sample(updatable, rng.randint(1, 3))
                old_fields: dict = {}
                new_fields: dict = {}
                for field in fields_to_change:
                    old_fields[field] = old_entity[field]
                    if field in ("x", "y"):
                        new_fields[field] = random_number(rng)
                    elif field in ("width", "height"):
                        new_fields[field] = abs(random_number(rng))
                    elif field == "content":
                        new_fields[field] = random_string(rng)
                    elif field == "color":
                        new_fields[field] = [rng.random() for _ in range(4)]
                    elif field == "tags":
                        new_fields[field] = [
                            random_string(rng, 20) for _ in range(rng.randint(0, 5))
                        ]

                # Apply to our tracking state
                for k, v in new_fields.items():
                    entities_by_id[target_id][k] = v

                eid, change = make_update_change(target_id, old_fields, new_fields)
                delta_data[eid] = change

            elif op == "delete" and note_ids:
                # Delete a note (not a page — avoid orphans)
                alive_notes = [
                    n
                    for n in note_ids
                    if n not in deleted_ids and n not in already_in_delta
                ]
                if not alive_notes:
                    continue
                target_id = rng.choice(alive_notes)
                entity = entities_by_id[target_id]
                eid, change = make_delete_change(entity)
                delta_data[eid] = change
                deleted_ids.add(target_id)

            elif op == "reparent" and note_ids:
                # Change a note's parent_id to a different page
                alive_notes = [
                    n
                    for n in note_ids
                    if n not in deleted_ids and n not in already_in_delta
                ]
                if not alive_notes or len(page_ids) < 2:
                    continue
                target_id = rng.choice(alive_notes)
                old_entity = entities_by_id[target_id]
                old_parent = old_entity["parent_id"]
                new_parent = rng.choice([p for p in page_ids if p != old_parent])

                old_fields = {"parent_id": old_parent}
                new_fields = {"parent_id": new_parent}
                entities_by_id[target_id]["parent_id"] = new_parent

                eid, change = make_update_change(target_id, old_fields, new_fields)
                delta_data[eid] = change

            elif op == "recreate" and deleted_ids:
                # Recreate a previously-deleted entity with new data
                candidates = [eid for eid in deleted_ids if eid not in already_in_delta]
                if not candidates:
                    continue
                target_id = rng.choice(candidates)
                parent = rng.choice(page_ids)
                entity = make_note(rng, target_id, parent)
                entities_by_id[target_id] = entity
                deleted_ids.discard(target_id)

                eid, change = make_create_change(entity)
                delta_data[eid] = change
            else:
                continue

            ops_done += 1

        if delta_data:
            deltas.append(delta_data)

    return {
        "description": f"Fuzz fixture (seed={seed}, entities={entity_count}, deltas={delta_count})",
        "entities": initial_entities,
        "deltas": deltas,
    }


def export_from_db(db_path: str, branch: str = "main") -> dict:
    """Export entities from a SQLite VCS database by replaying all commits."""
    from fusion.libs.model import dump_to_dict
    from fusion.storage.delta import Delta
    from fusion.storage.in_memory_store import InMemoryStore
    from fusion.storage.sqlite_vcs_adapter import SqliteVcsAdapter

    adapter = SqliteVcsAdapter(Path(db_path))
    graph = adapter.get_commit_graph()
    commit_metas = graph.branch_commits(branch)
    commit_ids = [c.id for c in commit_metas]
    commits = adapter.get_commits(commit_ids)

    store = InMemoryStore()
    for commit in commits:
        delta = Delta.from_data(commit.delta_data)
        store.apply_delta(delta)

    entities = []
    for entity in store.find():
        entities.append(dump_to_dict(entity))

    return {
        "description": f"Exported from {Path(db_path).name}, branch={branch}, commits={len(commits)}",
        "entities": entities,
    }


def main():
    parser = argparse.ArgumentParser(description="Generate hash parity test fixtures")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--export", metavar="DB_PATH", help="Export from SQLite VCS DB")
    group.add_argument(
        "--fuzz", action="store_true", help="Generate random entities + deltas"
    )
    parser.add_argument("--seed", type=int, default=42, help="RNG seed for fuzz mode")
    parser.add_argument(
        "--count", type=int, default=50, help="Initial entity count for fuzz"
    )
    parser.add_argument(
        "--deltas", type=int, default=20, help="Number of deltas to generate"
    )
    parser.add_argument("--branch", default="main", help="Branch name for export mode")

    args = parser.parse_args()

    if args.export:
        fixture = export_from_db(args.export, args.branch)
    else:
        fixture = generate_fuzz_fixture(args.seed, args.count, args.deltas)

    json.dump(fixture, sys.stdout, indent=2, ensure_ascii=False)
    print()  # trailing newline


if __name__ == "__main__":
    main()
