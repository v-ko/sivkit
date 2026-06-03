from collections.abc import Callable, Generator
from typing import Any

from sivkit import Entity
from sivkit.libs.model import load_from_dict, transformed_entity
from sivkit.storage.change import Change
from sivkit.storage.delta import Delta


class Store:
    _applying_internally: bool = False

    def __init__(self) -> None:
        self._on_changes_callbacks: list[Callable[[Delta, str | None], None]] = []

    # --- on_changes multi-handler API ---

    def add_on_changes_callback(
        self, callback: Callable[[Delta, str | None], None]
    ) -> None:
        self._on_changes_callbacks.append(callback)

    def remove_on_changes_callback(
        self, callback: Callable[[Delta, str | None], None]
    ) -> None:
        self._on_changes_callbacks.remove(callback)

    def _fire_on_changes(self, delta: Delta, origin: str | None = None) -> None:
        for cb in self._on_changes_callbacks:
            cb(delta, origin)

    @property
    def on_changes(self) -> Callable[[Delta, str | None], None] | None:
        """Backward-compat: returns the fire method if callbacks are registered."""
        if self._on_changes_callbacks:
            return self._fire_on_changes
        return None

    @on_changes.setter
    def on_changes(self, callback: Callable[[Delta, str | None], None] | None) -> None:
        """Backward-compat: replaces all callbacks with a single one."""
        self._on_changes_callbacks.clear()
        if callback is not None:
            self._on_changes_callbacks.append(callback)

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
        self._applying_internally = True
        try:
            applied = self._apply_change_core(change)
        finally:
            self._applying_internally = False

        if self._on_changes_callbacks and not applied.is_empty():
            self._fire_on_changes(Delta.from_changes([applied]), origin)
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
        self._applying_internally = True

        applied = Delta()
        try:
            for change in delta.changes():
                applied_change = self._apply_change_core(change)
                applied.add_change(applied_change)
        finally:
            self._applying_internally = False

        if self._on_changes_callbacks and not applied.is_empty():
            self._fire_on_changes(applied, origin)
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
