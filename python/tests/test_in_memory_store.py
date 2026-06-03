"""Tests for InMemoryStore copy-on-insert/update semantics."""

from sivkit import Entity, entity_type
from sivkit.storage.in_memory_store import InMemoryStore


@entity_type
class _StoreTestEntity(Entity):
    name: str = ""


def test_store_copies_on_insert_and_update():
    store = InMemoryStore()
    entity = _StoreTestEntity(id="e1", name="original")
    store.insert_one(entity)

    # Insert made a copy — mutating original doesn't affect store
    entity.name = "mutated"
    assert store.find_one(id="e1").name == "original"
    assert store.find_one(id="e1") is not entity

    # update_one detects the diff and fires on_changes
    received = []
    store.add_on_changes_callback(lambda d, o: received.append(d))
    change = store.update_one(entity)
    assert not change.is_empty()
    assert store.find_one(id="e1").name == "mutated"
    assert len(received) == 1

    # find returns a copy — mutating it doesn't affect store
    found = store.find_one(id="e1")
    found.name = "sneaky"
    assert store.find_one(id="e1").name == "mutated"
