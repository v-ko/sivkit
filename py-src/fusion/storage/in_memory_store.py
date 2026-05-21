from collections import defaultdict
from collections.abc import Generator, Iterable
from threading import RLock
from typing import Any

from fusion.libs.model import Entity
from fusion.storage.base_store import Store
from fusion.storage.change import Change
from fusion.storage.delta import Delta
from fusion.util import find_many_by_props


class InMemoryStore(Store):

    def __init__(
        self,
        types_for_cached_type_filtering: tuple[type[Entity], ...] | None = None,
    ) -> None:
        super().__init__()
        self.types_for_cached_type_filtering = types_for_cached_type_filtering
        self._lock = RLock()

        self._entity_cache: dict[str, Entity] = {}
        self._entity_cache_by_parent: defaultdict[str, set[Entity]] = defaultdict(set)
        self._entity_cache_by_type: defaultdict[type[Entity], set[Entity]] = (
            defaultdict(set)
        )

    def clear(self) -> None:
        """Remove all entities from the store."""
        with self._lock:
            self._entity_cache.clear()
            self._entity_cache_by_parent.clear()
            self._entity_cache_by_type.clear()
            self._loaded = False

    def type_cache_supported_subclass(self, entity: Entity) -> type[Entity] | None:
        if not self.types_for_cached_type_filtering:
            return None

        for supported_class in self.types_for_cached_type_filtering:
            if isinstance(entity, supported_class):
                return supported_class
        return None

    def upsert_to_cache(self, entity: Entity) -> Entity | None:
        """Adds an entity to the cache. Returns the old entity or None"""
        old_entity = self.pop_from_cache(entity.id)

        # Insert it into the indices
        self._entity_cache[entity.id] = entity

        if self.types_for_cached_type_filtering:
            supported_subclass = self.type_cache_supported_subclass(entity)
            if supported_subclass:
                self._entity_cache_by_type[supported_subclass].add(entity)
        if entity.parent_id:
            self._entity_cache_by_parent[entity.parent_id].add(entity)
        return old_entity

    def pop_from_cache(self, entity_id: str) -> Entity | None:
        entity = self._entity_cache.pop(entity_id, None)
        if not entity:
            return None

        if self.types_for_cached_type_filtering:
            supported_subclass = self.type_cache_supported_subclass(entity)
            if supported_subclass:
                self._entity_cache_by_type[supported_subclass].remove(entity)

        if entity.parent_id:
            self._entity_cache_by_parent[entity.parent_id].remove(entity)

        return entity

    def insert_one(self, entity: Entity) -> Change:
        with self._lock:
            if entity.id in self._entity_cache:
                raise Exception(
                    f"Cannot insert entity with id={entity.id!r} ({type(entity).__name__}), "
                    f"since it already exists"
                )

            self.upsert_to_cache(entity)
            change = Change.create(entity)
            if self._on_changes_callbacks and not self._applying_internally:
                self._fire_on_changes(Delta.from_changes([change]), None)
            return change

    def update_one(self, entity: Entity) -> Change:
        with self._lock:
            old_entity = self.pop_from_cache(entity.id)
            if not old_entity:
                raise Exception(f"Cannot update missing {entity}")

            self.upsert_to_cache(entity)
            change = Change.update(old_entity, entity)
            if (
                self._on_changes_callbacks
                and not self._applying_internally
                and not change.is_empty()
            ):
                self._fire_on_changes(Delta.from_changes([change]), None)
            return change

    def remove_one(self, entity: Entity) -> Change:
        with self._lock:
            old_entity = self.pop_from_cache(entity.id)
            if not old_entity:
                raise Exception(f"Cannot remove missing {entity}")

            change = Change.delete(old_entity)
            if self._on_changes_callbacks and not self._applying_internally:
                self._fire_on_changes(Delta.from_changes([change]), None)
            return change

    def find(
        self,
        id: str | None = None,
        type: type[Entity] | None = None,
        parent_id: str | None = None,
        **filter: Any,
    ) -> Generator[Entity, None, None]:
        with self._lock:
            # If searching by id - there will be only one unique result (if any)
            if id is not None:
                try:
                    result = self._entity_cache.get(id)
                except TypeError:
                    result = None
                if result:
                    yield result.copy()
                return

            # If searching by parent_id - use the index to do it efficiently
            search_set: Iterable[Entity]
            if parent_id is not None:
                try:
                    search_set = self._entity_cache_by_parent.get(parent_id, set())
                except TypeError:
                    search_set = ()
            else:
                search_set = set(self._entity_cache.values())

            # Searching by type is a special case
            if type is not None:
                if (
                    self.types_for_cached_type_filtering
                    and type in self.types_for_cached_type_filtering
                ):
                    type_search_set = self._entity_cache_by_type.get(type, set())
                    search_set = set(search_set).intersection(type_search_set)
                else:
                    search_set = (e for e in search_set if isinstance(e, type))

            # Apply the rest of the filter
            if filter:
                search_set = find_many_by_props(search_set, **filter)
            for entity in search_set:
                yield entity.copy()

    def load_data(self, entities: list[Entity], origin: str | None = None) -> Delta:
        with self._lock:
            return super().load_data(entities, origin)

    def apply_delta(self, delta: Delta, origin: str | None = None) -> Delta:
        with self._lock:
            return super().apply_delta(delta, origin)
