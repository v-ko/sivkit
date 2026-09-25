from collections.abc import Callable, Generator
from typing import Any

from sivkit import Entity
from sivkit.libs.action import check_in_action
from sivkit.libs.model import load_from_dict, transformed_entity
from sivkit.storage.change import Change
from sivkit.storage.delta import Delta

OnChangesCallback = Callable[[Delta, str | None], None]


class Store:
    _applying_internally: bool = False
    # When set, notifying operations must run inside an action (checked before the change).
    require_action: bool = False

    def __init__(self) -> None:
        self._on_changes_callbacks: list[OnChangesCallback] = []

    # --- on_changes multi-handler API ---

    def add_on_changes_callback(self, callback: OnChangesCallback) -> None:
        """Callbacks run synchronously, in registration order."""
        self._on_changes_callbacks.append(callback)

    def remove_on_changes_callback(self, callback: OnChangesCallback) -> None:
        self._on_changes_callbacks.remove(callback)

    def _assert_in_action_if_required(self) -> None:
        if self.require_action:
            check_in_action()

    def _fire_on_changes(self, delta: Delta, origin: str | None = None) -> None:
        for cb in list(self._on_changes_callbacks):
            cb(delta, origin)

    def _fire_on_changes_with_rollback(
        self, delta: Delta, origin: str | None = None
    ) -> None:
        """Fire the on_changes callbacks; if any raises, undo this call's
        changes, pass the reversed delta to the callbacks that already saw
        them, and re-raise.

        Atomicity across separate store calls is the caller's concern.
        """
        notified: list[OnChangesCallback] = []
        try:
            for cb in list(self._on_changes_callbacks):
                cb(delta, origin)
                notified.append(cb)
        except BaseException:
            was_applying = self._applying_internally
            self._applying_internally = True
            try:
                for change in reversed(list(delta.changes())):
                    self._apply_change_core(change.reversed())
            finally:
                self._applying_internally = was_applying
            reversed_delta = delta.reversed()
            for cb in notified:
                cb(reversed_delta, origin)
            raise

    def insert_one(self, entity: Entity) -> Change:
        raise NotImplementedError

    def find(self, **filter: Any) -> Generator[Any, None, None]:
        raise NotImplementedError

    def find_one(self, **filter: Any) -> Any | None:
        found = self.find(**filter)

        for f in found:
            return f

        return None

    def update_one(self, entity: Entity) -> Change:
        raise NotImplementedError

    def remove_one(self, entity: Entity) -> Change:
        raise NotImplementedError

    # Batch operations (inefficient implementations)
    def insert(self, batch: list[Entity]) -> list[Change]:
        return [self.insert_one(entity) for entity in batch]

    def remove(self, batch: list[Entity]) -> list[Change]:
        return [self.remove_one(entity) for entity in batch]

    def update(self, batch: list[Entity]) -> list[Change]:
        return [self.update_one(entity) for entity in batch]

    def apply_change(self, change: Change, origin: str | None = None) -> Change:
        self._assert_in_action_if_required()
        self._applying_internally = True
        try:
            applied = self._apply_change_core(change)
        finally:
            self._applying_internally = False

        if not applied.is_empty():
            self._fire_on_changes_with_rollback(Delta.from_changes([applied]), origin)
        return applied

    def clear(self) -> None:
        raise NotImplementedError

    _loaded: bool = False

    def load_data(self, entities: list[Entity], origin: str | None = None) -> Delta:
        """Load initial data into an empty (or cleared) store. Can only be called once, or again after clear()."""
        if self._loaded:
            raise RuntimeError(
                "Store already has data loaded. Call clear() before loading again."
            )
        self._applying_internally = True
        changes: list[Change] = []
        try:
            for entity in entities:
                changes.append(self.insert_one(entity))
        finally:
            self._applying_internally = False
            self._loaded = True

        return Delta.from_changes(changes)

    def apply_delta(self, delta: Delta, origin: str | None = None) -> Delta:
        """Apply all changes in a Delta to the store. Returns the applied delta."""
        self._assert_in_action_if_required()
        self._applying_internally = True

        applied = Delta()
        try:
            for change in delta.changes():
                applied_change = self._apply_change_core(change)
                applied.add_change(applied_change)
        finally:
            self._applying_internally = False

        if not applied.is_empty():
            self._fire_on_changes_with_rollback(applied, origin)
        return applied

    def _apply_change_core(self, change: Change) -> Change:
        """Apply a single change without firing on_changes."""
        if change.is_create():
            entity = load_from_dict(dict(change.forward_component))
            return self.insert_one(entity)
        elif change.is_update():
            entity = self.find_one(id=change.entity_id)
            if entity is None:
                raise ValueError(f"Entity {change.entity_id} not found for update")
            entity = transformed_entity(entity, change)
            return self.update_one(entity)
        elif change.is_delete():
            entity = self.find_one(id=change.entity_id)
            if entity is None:
                raise ValueError(f"Entity {change.entity_id} not found for delete")
            return self.remove_one(entity)
        return change
