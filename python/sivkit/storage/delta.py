from __future__ import annotations

from copy import deepcopy
from typing import Any, Generator

from sivkit.storage.change import Change, ChangeData, ChangeTypes

# Wire format: {entry_key: [entity_id, reverse_component, forward_component]}
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
    """Normalize a change in place and return whether it has no net effect."""
    change_type = change.type()
    if change_type == ChangeTypes.EMPTY:
        return True
    if change_type != ChangeTypes.UPDATE:
        return False

    reverse = change.reverse_component
    forward = change.forward_component
    cancelled_fields = set()
    for field in reverse.keys() & forward.keys():
        if _entity_keys_are_equal(reverse[field], forward[field]):
            cancelled_fields.add(field)

    if cancelled_fields:
        change.reverse_component = {
            key: value for key, value in reverse.items() if key not in cancelled_fields
        }
        change.forward_component = {
            key: value for key, value in forward.items() if key not in cancelled_fields
        }
    return not change.reverse_component and not change.forward_component


def _apply_components(data: dict, reverse: dict, forward: dict) -> dict:
    """Return updated data, preserving unrelated fields and field absence."""
    result = dict(data)
    for key in reverse.keys() - forward.keys():
        result.pop(key, None)
    result.update(forward)
    return result


class Delta:
    """Changes to entities, with their before-state retained for undo.

    Composition combines consecutive changes into a single net change.
    """

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
        """Deserialize [entity_id, reverse, forward] entries, preserving their keys."""
        changes: dict[str, Change] = {}
        for key, raw in data.items():
            changes[key] = Change(raw[0], raw[1], raw[2])
        return Delta(changes)

    def asdict(self) -> DeltaData:
        return {key: change.asdict() for key, change in self._data.items()}

    def changes(self) -> Generator[Change, None, None]:
        yield from self._data.values()

    def copy(self) -> Delta:
        new_changes: dict[str, Change] = {}
        for key, change in self._data.items():
            new_changes[key] = Change(
                change.entity_id,
                deepcopy(change.reverse_component),
                deepcopy(change.forward_component),
            )
        return Delta(new_changes)

    def reversed(self) -> Delta:
        return Delta({key: change.reversed() for key, change in self._data.items()})

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
        return all(change.is_empty() for change in self._data.values())

    def entity_ids(self) -> list[str]:
        return list(self._data.keys())

    def change(self, entity_id: str) -> Change | None:
        return self._data.get(entity_id)

    def merge_change_with_priority(self, change: Change) -> None:
        """Merge a new change into the existing delta for the same entity, in place.

        The result has the same effect as applying the existing change followed
        by the new one. For affected fields, forward keeps the final state and
        reverse keeps the earliest state, including field absence.

        Supported merge patterns:
        1) Update > Update: combine updates, canceling fields restored to their old state
        2) Create > Update: create with the updated values and field removals
        3) Delete > Create: becomes an update (old → new), or cancels if identical
        4) Create > Delete: cancels out (removed entirely)
        5) Update > Delete: delete with the original state in reverse

        Empty on either side leaves the other change unchanged. Impossible
        lifecycle sequences, such as Create > Create, raise ValueError.
        """
        first_change = self._data.get(change.entity_id)

        if first_change is None:
            self._data[change.entity_id] = change
            return

        first_ct = first_change.type()
        next_ct = change.type()

        # Empty changes have no effect on composition.
        if next_ct == ChangeTypes.EMPTY:
            return
        if first_ct == ChangeTypes.EMPTY:
            self._data[change.entity_id] = change
            return

        # 1) Update > Update
        if first_ct == ChangeTypes.UPDATE and next_ct == ChangeTypes.UPDATE:
            first_keys = (
                first_change.reverse_component.keys()
                | first_change.forward_component.keys()
            )
            reverse = dict(first_change.reverse_component)
            # A field already affected by the first change must keep its original
            # before-state, even if that state was absence (no reverse entry).
            for key, value in change.reverse_component.items():
                if key not in first_keys:
                    reverse[key] = value
            first_change.reverse_component = reverse
            first_change.forward_component = _apply_components(
                first_change.forward_component,
                change.reverse_component,
                change.forward_component,
            )
            if _change_reduces_to_none(first_change):
                self.remove_change(change.entity_id)

        # 2) Create > Update
        elif first_ct == ChangeTypes.CREATE and next_ct == ChangeTypes.UPDATE:
            first_change.forward_component = _apply_components(
                first_change.forward_component,
                change.reverse_component,
                change.forward_component,
            )

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
            # Undo must restore removed fields and leave added fields absent,
            # rather than restore the state at deletion time.
            original_state = _apply_components(
                change.reverse_component,
                first_change.forward_component,
                first_change.reverse_component,
            )
            self._data[change.entity_id] = Change(
                change.entity_id,
                original_state,
                {},
            )

        else:
            raise ValueError(
                f"Cannot compose {first_ct.name} then {next_ct.name} "
                f"for {change.entity_id}"
            )

    def merge_with_priority(self, next_delta: Delta) -> None:
        """Compose another delta after this one, in place."""
        for change in next_delta.changes():
            self.merge_change_with_priority(change)


def squash_deltas(deltas: list[DeltaData]) -> Delta:
    """Compose wire-format deltas in order into one net change."""
    squashed = Delta()
    for delta_data in deltas:
        squashed.merge_with_priority(Delta.from_data(delta_data))
    return squashed
