from __future__ import annotations

import logging
from copy import deepcopy
from typing import Any, Generator

from sivkit.storage.change import Change, ChangeData, ChangeTypes

log = logging.getLogger(__name__)

# {entity_id: [entity_id, reverse_component, forward_component]}
DeltaData = dict[str, ChangeData]


def _entity_keys_are_equal(value1: Any, value2: Any, depth: int = 1) -> bool:
    """Deep equality check for entity property values, up to 3 levels.

    Max depth matches entity property nesting convention:
    e.g. entity.content.image.height = 3 levels
    (1: property scope, 2: property object, 3: leaf key)
    """
    if depth > 3:
        raise ValueError(
            "Entity key comparison exceeded max depth of 3 — "
            "entity properties should not nest deeper than "
            "property.object.key (e.g. content.image.height)."
        )

    if type(value1) != type(value2):
        return False

    if value1 is None or value2 is None:
        return value1 == value2

    if not isinstance(value1, (dict, list)):
        return value1 == value2

    if isinstance(value1, list):
        if len(value1) != len(value2):
            return False
        return all(
            _entity_keys_are_equal(v1, v2, depth + 1) for v1, v2 in zip(value1, value2)
        )

    # Both are dicts
    if value1.keys() != value2.keys():
        return False
    return all(_entity_keys_are_equal(value1[k], value2[k], depth + 1) for k in value1)


def _change_reduces_to_none(change: Change) -> bool:
    """Check if an update change is a no-op (forward == reverse for all keys)."""
    if not change.is_update():
        return False

    reverse = dict(change.reverse_component)
    forward = dict(change.forward_component)

    for key in list(reverse.keys()):
        if key not in forward:
            continue
        if _entity_keys_are_equal(reverse[key], forward[key]):
            del reverse[key]
            del forward[key]

    change.reverse_component = reverse
    change.forward_component = forward

    return len(reverse) == 0 and len(forward) == 0


class Delta:
    """A collection of Changes grouped by entity ID, with merge logic."""

    def __init__(self, changes: dict[str, Change] | None = None):
        self._data: dict[str, Change] = changes or {}

    @staticmethod
    def from_changes(changes: list[Change]) -> Delta:
        delta = Delta()
        for change in changes:
            delta.add_change(change)
        return delta

    @staticmethod
    def from_data(data: DeltaData) -> Delta:
        """Deserialize wire-format delta (values are [eid, reverse, forward] lists)."""
        changes: dict[str, Change] = {}
        for eid, raw in data.items():
            changes[eid] = Change(raw[0], raw[1], raw[2])
        return Delta(changes)

    def asdict(self) -> DeltaData:
        return {eid: change.asdict() for eid, change in self._data.items()}

    def changes(self) -> Generator[Change, None, None]:
        for change in self._data.values():
            yield change

    def copy(self) -> Delta:
        new_changes: dict[str, Change] = {}
        for eid, change in self._data.items():
            new_changes[eid] = Change(
                change.entity_id,
                deepcopy(change.reverse_component),
                deepcopy(change.forward_component),
            )
        return Delta(new_changes)

    def reversed(self) -> Delta:
        reversed_changes: dict[str, Change] = {}
        for eid, change in self._data.items():
            reversed_changes[eid] = change.reversed()
        return Delta(reversed_changes)

    def add_change(self, change: Change) -> None:
        """Add a change, merging if one already exists for this entity."""
        if change.entity_id in self._data:
            self.merge_change_with_priority(change)
        else:
            self._data[change.entity_id] = change

    def remove_change(self, entity_id: str) -> None:
        if entity_id not in self._data:
            raise KeyError(f"No change for entity {entity_id}")
        del self._data[entity_id]

    def is_empty(self) -> bool:
        for change in self._data.values():
            if not change.is_empty():
                return False
        return True

    def entity_ids(self) -> list[str]:
        return list(self._data.keys())

    def change(self, entity_id: str) -> Change | None:
        return self._data.get(entity_id)

    def merge_change_with_priority(self, change: Change) -> None:
        """Merge a new change into the existing delta for the same entity.

        Supported merge patterns:
        1) Update > Update: combine forward/reverse fields
        2) Create > Update: extend the create's forward component
        3) Delete > Create: becomes an update (old → new)
        4) Create > Delete: cancels out (removed entirely)
        5) Otherwise: log error
        """
        first_change = self._data.get(change.entity_id)

        if first_change is None:
            self.add_change(change)
            return

        first_ct = first_change.type()
        next_ct = change.type()

        # 1) Update > Update
        if first_ct == ChangeTypes.UPDATE and next_ct == ChangeTypes.UPDATE:
            first_change.forward_component = {
                **first_change.forward_component,
                **change.forward_component,
            }
            first_change.reverse_component = {
                **change.reverse_component,
                **first_change.reverse_component,
            }
            if _change_reduces_to_none(first_change):
                self.remove_change(change.entity_id)

        # 2) Create > Update
        elif first_ct == ChangeTypes.CREATE and next_ct == ChangeTypes.UPDATE:
            first_change.forward_component = {
                **first_change.forward_component,
                **change.forward_component,
            }

        # 3) Delete > Create
        elif first_ct == ChangeTypes.DELETE and next_ct == ChangeTypes.CREATE:
            merged = Change(
                change.entity_id,
                first_change.reverse_component,
                change.forward_component,
            )
            if _change_reduces_to_none(merged):
                self.remove_change(change.entity_id)
            else:
                self._data[change.entity_id] = merged

        # 4) Create > Delete
        elif first_ct == ChangeTypes.CREATE and next_ct == ChangeTypes.DELETE:
            self.remove_change(change.entity_id)

        # 5) Update > Delete
        elif first_ct == ChangeTypes.UPDATE and next_ct == ChangeTypes.DELETE:
            # Net effect = DELETE with the original state (before the update).
            # The DELETE's reverse has the full state at deletion time (S1).
            # Overlay the UPDATE's reverse fields to recover pre-update state (S0).
            original_state = {
                **change.reverse_component,
                **first_change.reverse_component,
            }
            self._data[change.entity_id] = Change(
                change.entity_id,
                original_state,
                {},
            )

        # 6) Empty or irrational
        elif next_ct == ChangeTypes.EMPTY:
            pass
        else:
            log.error(
                f"[merge_change_with_priority] Irrational delta sequence. "
                f"Merging {change} INTO {first_change}"
            )

    def merge_with_priority(self, next_delta: Delta) -> None:
        """Merge another delta into this one, in place."""
        for change in next_delta.changes():
            self.merge_change_with_priority(change)


def squash_deltas(deltas: list[DeltaData]) -> Delta:
    """Reduce an array of wire-format DeltaData dicts into one Delta."""
    squashed = Delta()
    for delta_data in deltas:
        squashed.merge_with_priority(Delta.from_data(delta_data))
    return squashed
