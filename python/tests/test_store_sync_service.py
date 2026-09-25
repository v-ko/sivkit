"""Tests for StoreSyncService — the server-side store-sync protocol."""

import asyncio

from sivkit import Entity, entity_type
from sivkit.storage.change import Change
from sivkit.storage.delta import Delta
from sivkit.storage.in_memory_store import InMemoryStore
from sivkit.storage.store_sync_service import STALE, StoreSyncService


@entity_type
class TestConfigEntity(Entity):
    name: str = ""
    value: str = ""


def _make_wired_store_and_sss(**kwargs) -> tuple[InMemoryStore, StoreSyncService]:
    """Create a store with SSS wired as the on_changes listener."""
    store = InMemoryStore()
    sss = StoreSyncService(store, **kwargs)
    store.add_on_changes_callback(
        lambda delta, origin: sss.on_store_changes(delta, origin)
    )
    return store, sss


def test_full_state_empty():
    store = InMemoryStore()
    sss = StoreSyncService(store)
    state = sss.full_state()
    assert state == {"seq": 0, "entities": []}


def test_full_state_with_entities():
    store = InMemoryStore()
    e = TestConfigEntity(id="e1", name="hello", value="world")
    store.insert_one(e)
    sss = StoreSyncService(store)
    state = sss.full_state()
    assert state["seq"] == 0
    assert len(state["entities"]) == 1
    assert state["entities"][0]["id"] == "e1"
    assert state["entities"][0]["type_name"] == "TestConfigEntity"


def test_store_change_create():
    store, sss = _make_wired_store_and_sss()

    e = TestConfigEntity(id="e1", name="hello", value="world")
    change = Change.create(e)
    store.apply_delta(Delta.from_changes([change]))

    assert sss.seq == 1
    found = store.find_one(id="e1")
    assert found is not None
    assert found.name == "hello"


def test_store_change_update():
    store, sss = _make_wired_store_and_sss()

    e = TestConfigEntity(id="e1", name="hello", value="world")
    store.apply_delta(Delta.from_changes([Change.create(e)]))
    assert sss.seq == 1

    e2 = TestConfigEntity(id="e1", name="updated", value="world")
    change = e.change_from(e2)
    store.apply_delta(Delta.from_changes([change]))
    assert sss.seq == 2

    found = store.find_one(id="e1")
    assert found.name == "updated"


def test_subscribe_replays_missed():
    """Subscribe with after=0 after some changes should replay them."""

    async def _test():
        store, sss = _make_wired_store_and_sss()

        e = TestConfigEntity(id="e1", name="hello", value="world")
        store.apply_delta(Delta.from_changes([Change.create(e)]))

        items = []
        async for item in sss.subscribe(after=0):
            items.append(item)
            break

        assert len(items) == 1
        seq, delta_data = items[0]
        assert seq == 1
        assert isinstance(delta_data, dict)

    asyncio.run(_test())


def test_subscribe_streams_new():
    """Subscribe then apply changes — subscriber should receive them."""

    async def _test():
        store, sss = _make_wired_store_and_sss()

        received = []

        async def consumer():
            async for item in sss.subscribe(after=0):
                received.append(item)
                if len(received) >= 1:
                    break

        async def producer():
            await asyncio.sleep(0.01)
            e = TestConfigEntity(id="e1", name="hello", value="world")
            store.apply_delta(Delta.from_changes([Change.create(e)]))

        await asyncio.gather(consumer(), producer())

        assert len(received) == 1
        seq, changes = received[0]
        assert seq == 1

    asyncio.run(_test())


def test_subscribe_stale():
    """Subscribe with a too-old after value yields the STALE sentinel."""

    async def _test():
        store, sss = _make_wired_store_and_sss(buffer_size=2)

        for i in range(3):
            e = TestConfigEntity(id=f"e{i}", name=f"name{i}", value=f"val{i}")
            store.apply_delta(Delta.from_changes([Change.create(e)]))

        items = []
        async for item in sss.subscribe(after=0):
            items.append(item)
            break

        assert len(items) == 1
        assert items[0] is STALE

    asyncio.run(_test())


def test_subscribers_notified_on_store_change():
    """Multiple deltas are streamed to the subscriber in order."""

    async def _test():
        store, sss = _make_wired_store_and_sss()

        received = []

        async def consumer():
            async for item in sss.subscribe(after=0):
                received.append(item)
                if len(received) >= 2:
                    break

        async def producer():
            await asyncio.sleep(0.01)
            e1 = TestConfigEntity(id="e1", name="from_a", value="v1")
            store.apply_delta(Delta.from_changes([Change.create(e1)]))
            e2 = TestConfigEntity(id="e2", name="from_b", value="v2")
            store.apply_delta(Delta.from_changes([Change.create(e2)]))

        await asyncio.gather(consumer(), producer())

        assert len(received) == 2
        assert received[0][0] == 1
        assert received[1][0] == 2

    asyncio.run(_test())


def test_on_store_changes_called_via_on_changes():
    """Verify on_store_changes gets called as a store on-changes callback."""
    store, sss = _make_wired_store_and_sss()

    e = TestConfigEntity(id="e1", name="hello", value="world")
    store.apply_delta(Delta.from_changes([Change.create(e)]))

    assert sss.seq == 1
    assert len(sss.delta_log) == 1
