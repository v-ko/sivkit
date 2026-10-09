"""Hash parity test — Python side.

Replays fixture deltas and compares incremental hashes with full rebuilds.
expected_states checks exact entity data at each step; check_composition
checks composed replay and both composed and sequential undo.

Each fixture file is a JSON array of test cases.

Usage:
    python test-parity-py.py [fixture.json]

Defaults to fixtures/fuzz-42.json if no argument given.
"""

import json
import sys
from pathlib import Path

import attrs

from sivkit.libs.model import Entity, dump_to_dict, entity_type, load_from_dict
from sivkit.storage.delta import Delta, squash_deltas
from sivkit.storage.hash_tree import build_hash_tree, update_hash_tree
from sivkit.storage.in_memory_store import InMemoryStore

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


def sorted_entity_data(entities_data):
    return sorted(entities_data, key=lambda data: data["id"])


def entity_data(store):
    return sorted_entity_data([dump_to_dict(entity) for entity in store.find()])


def assert_entity_data(store, expected, message):
    actual = entity_data(store)
    expected = sorted_entity_data(expected)
    assert actual == expected, f"{message}: expected {expected!r}, got {actual!r}"


def make_store(entities_data):
    store = InMemoryStore()
    for entity_dict in entities_data:
        store.insert_one(load_from_dict(dict(entity_dict)))
    return store


def check_composition_and_undo(initial_state, deltas, sequential_final_state):
    # One squashed delta must reach the same state as replaying every delta.
    squashed_delta = squash_deltas(deltas)
    composed_store = make_store(initial_state)
    composed_store.apply_delta(squashed_delta)
    assert_entity_data(
        composed_store, sequential_final_state, "composed replay differs"
    )

    # Undoing the squashed delta must restore the exact initial data.
    composed_store.apply_delta(squashed_delta.reversed())
    assert_entity_data(
        composed_store,
        initial_state,
        "composed inverse does not restore original entity data",
    )

    # Undoing individual deltas, last to first, must restore the same data.
    undo_store = make_store(sequential_final_state)
    for delta_data in reversed(deltas):
        inverse_delta = Delta.from_data(delta_data).reversed()
        undo_store.apply_delta(inverse_delta)
    assert_entity_data(
        undo_store,
        initial_state,
        "sequential inverses do not restore original entity data",
    )


def run_fixture(fixture):
    name = fixture.get("name", "fixture")
    initial_state = fixture["entities"]
    deltas = fixture.get("deltas", [])
    expected_states = fixture.get("expected_states")

    # State 0 is the initial data; each delta adds one expected state.
    if expected_states is not None:
        assert (
            len(expected_states) == len(deltas) + 1
        ), "expected_states must include initial state and each replayed state"
    store = make_store(initial_state)
    tree = build_hash_tree(store)

    def check_state_and_hash(step):
        if expected_states is not None:
            assert_entity_data(
                store, expected_states[step], f"step {step}: entity data mismatch"
            )
        rebuilt_tree = build_hash_tree(store)
        assert (
            tree.root_hash() == rebuilt_tree.root_hash()
        ), f"step {step}: incremental hash differs from rebuild"
        print(f"Checkpoint hash: {name}:{step}:{tree.root_hash()}")

    print(f"Case: {name}; entities: {len(initial_state)}; deltas: {len(deltas)}")

    # Check the loaded state before replay, including model-induced data changes.
    check_state_and_hash(0)

    # Replay in order, updating the hash tree alongside the store.
    for step, delta_data in enumerate(deltas, start=1):
        delta = Delta.from_data(delta_data)
        store.apply_delta(delta)
        update_hash_tree(tree, store, delta)

        # With expected states, check every step; otherwise check the final state.
        is_last_step = step == len(deltas)
        if expected_states is not None or is_last_step:
            check_state_and_hash(step)

    # Compare delta algebra against the sequential replay we just performed.
    if fixture.get("check_composition"):
        check_composition_and_undo(initial_state, deltas, entity_data(store))

    print(f"Root hash: {tree.root_hash()}")
    print(f"PASS: {name}")


def main():
    here = Path(__file__).parent
    fixture_path = (
        Path(sys.argv[1]) if len(sys.argv) > 1 else here / "fixtures" / "fuzz-42.json"
    )
    cases = json.loads(fixture_path.read_text())

    # Finish all cases even when one fails, then fail the command.
    failed_cases = 0
    for test_case in cases:
        try:
            run_fixture(test_case)
        except Exception as error:
            failed_cases += 1
            print(
                f"FAIL: {test_case.get('name', 'fixture')}: {type(error).__name__}: {error}"
            )
    if failed_cases > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
