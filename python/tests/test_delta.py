"""Tests for Delta merge and squash operations."""

import pytest

from sivkit.storage.change import ChangeTypes
from sivkit.storage.delta import Delta, squash_deltas

# --- mergeChangeWithPriority ---

MERGE_CASES = [
    (
        "UPDATE > UPDATE (same field cancels)",
        {"e": ["e", {"x": 1}, {"x": 2}]},
        {"e": ["e", {"x": 2}, {"x": 1}]},
        None,
        None,
        None,
    ),
    (
        "UPDATE > UPDATE (different fields accumulate)",
        {"e": ["e", {"x": 1}, {"x": 2}]},
        {"e": ["e", {"y": 3}, {"y": 4}]},
        ChangeTypes.UPDATE,
        {"y": 3, "x": 1},
        {"y": 4, "x": 2},
    ),
    (
        "UPDATE > UPDATE (same field, second wins forward)",
        {"e": ["e", {"x": 1}, {"x": 2}]},
        {"e": ["e", {"x": 2}, {"x": 3}]},
        ChangeTypes.UPDATE,
        {"x": 1},
        {"x": 3},
    ),
    (
        "CREATE > UPDATE (extends create forward)",
        {"e": ["e", {}, {"x": 1}]},
        {"e": ["e", {"x": 1}, {"x": 2}]},
        ChangeTypes.CREATE,
        {},
        {"x": 2},
    ),
    (
        "CREATE > DELETE (net nothing)",
        {"e": ["e", {}, {"x": 1, "y": 2}]},
        {"e": ["e", {"x": 1, "y": 2}, {}]},
        None,
        None,
        None,
    ),
    (
        "DELETE > CREATE (becomes update, unchanged fields stripped)",
        {"e": ["e", {"x": 1, "y": 2}, {}]},
        {"e": ["e", {}, {"x": 3, "y": 2}]},
        ChangeTypes.UPDATE,
        {"x": 1},
        {"x": 3},
    ),
    (
        "DELETE > CREATE same data (cancels to nothing)",
        {"e": ["e", {"x": 1}, {}]},
        {"e": ["e", {}, {"x": 1}]},
        None,
        None,
        None,
    ),
    (
        "UPDATE > DELETE (net = delete with original state)",
        {"e": ["e", {"color": "red"}, {"color": "blue"}]},
        {"e": ["e", {"color": "blue", "x": 10}, {}]},
        ChangeTypes.DELETE,
        {"color": "red", "x": 10},
        {},
    ),
]


@pytest.mark.parametrize(
    "desc,first_data,next_data,expected_type,expected_reverse,expected_forward",
    MERGE_CASES,
    ids=[c[0] for c in MERGE_CASES],
)
def test_merge_change_with_priority(
    desc, first_data, next_data, expected_type, expected_reverse, expected_forward
):
    delta = Delta.from_data(first_data)
    delta.merge_with_priority(Delta.from_data(next_data))
    change = delta.change("e")
    if expected_type is None:
        assert change is None
    else:
        assert change is not None
        assert change.type() == expected_type
        assert change.reverse_component == expected_reverse
        assert change.forward_component == expected_forward


# --- squashDeltas ---

SQUASH_CASES = [
    (
        "CREATE > UPDATE > DELETE = nothing",
        [
            {"e": ["e", {}, {"x": 1}]},
            {"e": ["e", {"x": 1}, {"x": 2}]},
            {"e": ["e", {"x": 2}, {}]},
        ],
        "e",
        None,
        None,
        None,
    ),
    (
        "multiple UPDATEs accumulate",
        [
            {"e": ["e", {"x": 1}, {"x": 2}]},
            {"e": ["e", {"x": 2}, {"x": 3}]},
            {"e": ["e", {"y": 0}, {"y": 5}]},
        ],
        "e",
        ChangeTypes.UPDATE,
        {"x": 1, "y": 0},
        {"x": 3, "y": 5},
    ),
    (
        "UPDATE > DELETE (pre-existing entity)",
        [
            {"e": ["e", {"x": 5}, {"x": 10}]},
            {"e": ["e", {"x": 10, "name": "foo"}, {}]},
        ],
        "e",
        ChangeTypes.DELETE,
        {"x": 5, "name": "foo"},
        {},
    ),
    (
        "DELETE > CREATE > UPDATE (re-creation cycle)",
        [
            {"e": ["e", {"x": 1, "y": 2}, {}]},
            {"e": ["e", {}, {"x": 10, "y": 20}]},
            {"e": ["e", {"x": 10}, {"x": 30}]},
        ],
        "e",
        ChangeTypes.UPDATE,
        {"x": 1, "y": 2},
        {"x": 30, "y": 20},
    ),
    (
        "independent entities (entity a)",
        [
            {"a": ["a", {}, {"v": 1}], "b": ["b", {"v": 0}, {"v": 1}]},
            {"a": ["a", {"v": 1}, {"v": 2}]},
            {"b": ["b", {"v": 1}, {}]},
        ],
        "a",
        ChangeTypes.CREATE,
        {},
        {"v": 2},
    ),
    (
        "independent entities (entity b)",
        [
            {"a": ["a", {}, {"v": 1}], "b": ["b", {"v": 0}, {"v": 1}]},
            {"a": ["a", {"v": 1}, {"v": 2}]},
            {"b": ["b", {"v": 1}, {}]},
        ],
        "b",
        ChangeTypes.DELETE,
        {"v": 0},
        {},
    ),
]


@pytest.mark.parametrize(
    "desc,deltas,entity_id,expected_type,expected_reverse,expected_forward",
    SQUASH_CASES,
    ids=[c[0] for c in SQUASH_CASES],
)
def test_squash_deltas(
    desc, deltas, entity_id, expected_type, expected_reverse, expected_forward
):
    squashed = squash_deltas(deltas)
    change = squashed.change(entity_id)
    if expected_type is None:
        assert change is None
    else:
        assert change is not None
        assert change.type() == expected_type
        assert change.reverse_component == expected_reverse
        assert change.forward_component == expected_forward
