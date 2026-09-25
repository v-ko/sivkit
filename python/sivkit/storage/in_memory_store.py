import threading
from collections import defaultdict
from collections.abc import Generator, Iterable
from typing import Any

from sivkit.libs.model import Entity
from sivkit.storage.base_store import Store
from sivkit.storage.change import Change
from sivkit.storage.delta import Delta
from sivkit.util import find_many_by_props


class StoreThreadViolation(RuntimeError):
    """Raised when a store is accessed off its owning thread.

    The store is single-threaded: it binds to the first thread that touches
    it. Run the operation on that thread, or marshal onto it (e.g.
    ``loop.call_soon_threadsafe`` / ``asyncio.run_coroutine_threadsafe``).
    """


class InMemoryStore(Store):

    def __init__(
        self,
        types_for_cached_type_filtering: tuple[type[Entity], ...] | None = None,
    ) -> None:
        super().__init__()
        self.types_for_cached_type_filtering = types_for_cached_type_filtering
        self._owner_thread_id: int | None = None

        self._entity_cache: dict[str, Entity] = {}
        self._entity_cache_by_parent: defaultdict[str, set[Entity]] = defaultdict(set)
        self._entity_cache_by_type: defaultdict[type[Entity], set[Entity]] = (
            defaultdict(set)
        )

    def bind_to_current_thread(self) -> None:
        """Bind (or rebind) store ownership to the calling thread.

        Call once at startup when the store is constructed on a different
        thread than the one that will own it (e.g. built on the main thread
        but served from an event loop running in another thread).
        """
        self._owner_thread_id = threading.get_ident()

    def _assert_owner_thread(self) -> None:
        tid = threading.get_ident()
        if self._owner_thread_id is None:
            self._owner_thread_id = tid
        elif tid != self._owner_thread_id:
            raise StoreThreadViolation(
                f"{type(self).__name__} is owned by thread id={self._owner_thread_id} "
                f"but was accessed from thread {threading.current_thread().name!r} "
                f"(id={tid}). Run the operation on the owning thread, or marshal onto "
                f"it via loop.call_soon_threadsafe / asyncio.run_coroutine_threadsafe."
            )

    def clear(self) -> None:
        """Remove all entities from the store."""
        self._assert_owner_thread()
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
        # Copy the entity to protect the cache from untracked changes.
        entity = entity.copy()
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
        self._assert_owner_thread()
        if not self._applying_internally:
            self._assert_in_action_if_required()
        if entity.id in self._entity_cache:
            raise Exception(
                f"Cannot insert entity with id={entity.id!r} ({type(entity).__name__}), "
                f"since it already exists"
            )

        self.upsert_to_cache(entity)
        change = Change.create(entity)
        if self._on_changes_callbacks and not self._applying_internally:
            self._fire_on_changes_with_rollback(Delta.from_changes([change]), None)
        return change

    def update_one(self, entity: Entity) -> Change:
        self._assert_owner_thread()
        if not self._applying_internally:
            self._assert_in_action_if_required()
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
            self._fire_on_changes_with_rollback(Delta.from_changes([change]), None)
        return change

    def remove_one(self, entity: Entity) -> Change:
        self._assert_owner_thread()
        if not self._applying_internally:
            self._assert_in_action_if_required()
        old_entity = self.pop_from_cache(entity.id)
        if not old_entity:
            raise Exception(f"Cannot remove missing {entity}")

        change = Change.delete(old_entity)
        if self._on_changes_callbacks and not self._applying_internally:
            self._fire_on_changes_with_rollback(Delta.from_changes([change]), None)
        return change

    def find(
        self,
        id: str | None = None,
        type: type[Entity] | None = None,
        parent_id: str | None = None,
        **filter: Any,
    ) -> Generator[Entity, None, None]:
        self._assert_owner_thread()
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
        self._assert_owner_thread()
        return super().load_data(entities, origin)

    def apply_delta(self, delta: Delta, origin: str | None = None) -> Delta:
        self._assert_owner_thread()
        return super().apply_delta(delta, origin)
