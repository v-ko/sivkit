"""Tests for Delta merge and squash operations."""

from copy import deepcopy

import pytest

from sivkit.storage.change import Change, ChangeTypes
from sivkit.storage.delta import Delta, squash_deltas

ENTITY_DATA = {"id": "e", "parent_id": "", "type_name": "DummyPage"}

CLASSIFICATION_CASES = [
    ("empty", {}, {}, ChangeTypes.EMPTY),
    (
        "create complete entity data",
        {},
        {"id": "e", "parent_id": "", "type_name": "DummyPage", "name": "page"},
        ChangeTypes.CREATE,
    ),
    (
        "delete complete entity data",
        {"id": "e", "parent_id": "", "type_name": "DummyPage", "name": "page"},
        {},
        ChangeTypes.DELETE,
    ),
    ("add field", {}, {"name": "page"}, ChangeTypes.UPDATE),
    ("remove field", {"name": "page"}, {}, ChangeTypes.UPDATE),
    ("absent to null", {}, {"name": None}, ChangeTypes.UPDATE),
    ("null to absent", {"name": None}, {}, ChangeTypes.UPDATE),
    (
        "create classification does not validate id",
        {},
        {**ENTITY_DATA, "id": "other"},
        ChangeTypes.CREATE,
    ),
    (
        "delete classification does not validate id",
        {**ENTITY_DATA, "id": "other"},
        {},
        ChangeTypes.DELETE,
    ),
]


@pytest.mark.parametrize(
    "desc,reverse,forward,expected_type",
    CLASSIFICATION_CASES,
    ids=[case[0] for case in CLASSIFICATION_CASES],
)
def test_change_classification(desc, reverse, forward, expected_type):
    change = Change("e", reverse, forward)
    assert change.type() == expected_type


def test_reversal_preserves_presence_and_is_involutive():
    data = {
        "created": ["created", {}, {**ENTITY_DATA, "id": "created"}],
        "deleted": ["deleted", {**ENTITY_DATA, "id": "deleted"}, {}],
        "updated": [
            "updated",
            {"removed": None, "name": "old"},
            {"added": None, "name": "new"},
        ],
    }
    delta = Delta.from_data(data)
    assert delta.reversed().asdict() == {
        "created": ["created", {**ENTITY_DATA, "id": "created"}, {}],
        "deleted": ["deleted", {}, {**ENTITY_DATA, "id": "deleted"}],
        "updated": [
            "updated",
            {"added": None, "name": "new"},
            {"removed": None, "name": "old"},
        ],
    }
    assert delta.reversed().reversed().asdict() == data


# --- merge_change_with_priority ---

MERGE_CASES = [
    (
        "same field cancels",
        {"e": ["e", {"x": 1}, {"x": 2}]},
        {"e": ["e", {"x": 2}, {"x": 1}]},
        {},
    ),
    (
        "different fields accumulate",
        {"e": ["e", {"x": 1}, {"x": 2}]},
        {"e": ["e", {"y": 3}, {"y": 4}]},
        {"e": ["e", {"x": 1, "y": 3}, {"x": 2, "y": 4}]},
    ),
    (
        "same field keeps earliest reverse and latest forward",
        {"e": ["e", {"x": 1}, {"x": 2}]},
        {"e": ["e", {"x": 2}, {"x": 3}]},
        {"e": ["e", {"x": 1}, {"x": 3}]},
    ),
    (
        "CREATE > UPDATE changes and removes fields",
        {"e": ["e", {}, {**ENTITY_DATA, "home": "page-a", "name": "first"}]},
        {"e": ["e", {"home": "page-a", "name": "first"}, {"name": "second"}]},
        {"e": ["e", {}, {**ENTITY_DATA, "name": "second"}]},
    ),
    (
        "CREATE > DELETE cancels",
        {"e": ["e", {}, dict(ENTITY_DATA)]},
        {"e": ["e", dict(ENTITY_DATA), {}]},
        {},
    ),
    (
        "DELETE > CREATE keeps only differing fields",
        {"e": ["e", {**ENTITY_DATA, "x": 1, "y": 2}, {}]},
        {"e": ["e", {}, {**ENTITY_DATA, "x": 3, "y": 2}]},
        {"e": ["e", {"x": 1}, {"x": 3}]},
    ),
    (
        "DELETE > CREATE identical data cancels",
        {"e": ["e", dict(ENTITY_DATA), {}]},
        {"e": ["e", {}, dict(ENTITY_DATA)]},
        {},
    ),
    (
        "UPDATE > DELETE restores original values and excludes added fields",
        {"e": ["e", {"name": "first"}, {"name": "second", "home": "page-a"}]},
        {"e": ["e", {**ENTITY_DATA, "name": "second", "home": "page-a", "x": 10}, {}]},
        {"e": ["e", {**ENTITY_DATA, "name": "first", "x": 10}, {}]},
    ),
    (
        "changed field then removed",
        {
            "e": [
                "e",
                {"home": "page-a", "name": "first"},
                {"home": "page-b", "name": "second"},
            ]
        },
        {"e": ["e", {"home": "page-b", "name": "second"}, {"name": "third"}]},
        {"e": ["e", {"home": "page-a", "name": "first"}, {"name": "third"}]},
    ),
    (
        "add > remove cancels absent endpoints",
        {"e": ["e", {}, {"home": "page-a"}]},
        {"e": ["e", {"home": "page-a"}, {}]},
        {},
    ),
    (
        "remove > re-add same value cancels",
        {"e": ["e", {"home": "page-a"}, {}]},
        {"e": ["e", {}, {"home": "page-a"}]},
        {},
    ),
    (
        "remove > re-add different value",
        {"e": ["e", {"home": "page-a"}, {}]},
        {"e": ["e", {}, {"home": "page-b"}]},
        {"e": ["e", {"home": "page-a"}, {"home": "page-b"}]},
    ),
    (
        "add null > replace preserves initial absence",
        {"e": ["e", {}, {"home": None}]},
        {"e": ["e", {"home": None}, {"home": "page-a"}]},
        {"e": ["e", {}, {"home": "page-a"}]},
    ),
    (
        "null > absent > value preserves original null",
        {"e": ["e", {"home": None}, {}]},
        {"e": ["e", {}, {"home": "page-a"}]},
        {"e": ["e", {"home": None}, {"home": "page-a"}]},
    ),
    (
        "EMPTY > UPDATE is identity",
        {"e": ["e", {}, {}]},
        {"e": ["e", {"x": 1}, {"x": 2}]},
        {"e": ["e", {"x": 1}, {"x": 2}]},
    ),
    (
        "UPDATE > EMPTY is identity",
        {"e": ["e", {"x": 1}, {"x": 2}]},
        {"e": ["e", {}, {}]},
        {"e": ["e", {"x": 1}, {"x": 2}]},
    ),
]


@pytest.mark.parametrize(
    "desc,first_data,next_data,expected",
    MERGE_CASES,
    ids=[case[0] for case in MERGE_CASES],
)
def test_merge_change_with_priority(desc, first_data, next_data, expected):
    delta = Delta.from_data(first_data)
    delta.merge_with_priority(Delta.from_data(next_data))
    assert delta.asdict() == expected


def test_invalid_lifecycle_composition_raises():
    create = {"e": ["e", {}, dict(ENTITY_DATA)]}
    with pytest.raises(ValueError):
        Delta.from_data(create).merge_with_priority(Delta.from_data(create))


# --- squash_deltas ---

SQUASH_CASES = [
    (
        "CREATE > UPDATE > DELETE cancels",
        [
            {"e": ["e", {}, {**ENTITY_DATA, "x": 1}]},
            {"e": ["e", {"x": 1}, {"x": 2}]},
            {"e": ["e", {**ENTITY_DATA, "x": 2}, {}]},
        ],
        {},
    ),
    (
        "multiple updates accumulate",
        [
            {"e": ["e", {"x": 1}, {"x": 2}]},
            {"e": ["e", {"x": 2}, {"x": 3}]},
            {"e": ["e", {"y": 0}, {"y": 5}]},
        ],
        {"e": ["e", {"x": 1, "y": 0}, {"x": 3, "y": 5}]},
    ),
    (
        "DELETE > CREATE > UPDATE",
        [
            {"e": ["e", {**ENTITY_DATA, "x": 1, "y": 2}, {}]},
            {"e": ["e", {}, {**ENTITY_DATA, "x": 10, "y": 20}]},
            {"e": ["e", {"x": 10}, {"x": 30}]},
        ],
        {"e": ["e", {"x": 1, "y": 2}, {"x": 30, "y": 20}]},
    ),
    (
        "independent entities do not interfere",
        [
            {
                "a": ["a", {}, {**ENTITY_DATA, "id": "a", "v": 1}],
                "b": ["b", {"v": 0}, {"v": 1}],
            },
            {"a": ["a", {"v": 1}, {"v": 2}]},
            {"b": ["b", {**ENTITY_DATA, "id": "b", "v": 1}, {}]},
        ],
        {
            "a": ["a", {}, {**ENTITY_DATA, "id": "a", "v": 2}],
            "b": ["b", {**ENTITY_DATA, "id": "b", "v": 0}, {}],
        },
    ),
    (
        "add > remove > re-add null",
        [
            {"e": ["e", {}, {"home": "page-a"}]},
            {"e": ["e", {"home": "page-a"}, {}]},
            {"e": ["e", {}, {"home": None}]},
        ],
        {"e": ["e", {}, {"home": None}]},
    ),
    (
        "replace > remove > re-add preserves original endpoint",
        [
            {"e": ["e", {"home": "page-a", "x": 0}, {"home": "page-b", "x": 1}]},
            {"e": ["e", {"home": "page-b", "x": 1}, {"x": 2}]},
            {"e": ["e", {"x": 2}, {"home": "page-c", "x": 3}]},
        ],
        {"e": ["e", {"home": "page-a", "x": 0}, {"home": "page-c", "x": 3}]},
    ),
]


@pytest.mark.parametrize(
    "desc,deltas,expected",
    SQUASH_CASES,
    ids=[case[0] for case in SQUASH_CASES],
)
def test_squash_deltas(desc, deltas, expected):
    original = deepcopy(deltas)
    assert squash_deltas(deltas).asdict() == expected
    assert deltas == original
