"""Tests for StoreSyncService — the server-side store-sync protocol."""

import asyncio
from contextlib import aclosing, asynccontextmanager

import pytest

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
    store.add_on_changes_callback(sss.on_store_changes)
    return store, sss


@asynccontextmanager
async def _live_subscription(service):
    stream = service.subscribe(after=service.seq)
    pending = asyncio.create_task(anext(stream))
    try:
        # Advance the generator to its live wait, without a wall-clock delay.
        await asyncio.sleep(0)
        assert service._subscribers and not pending.done()
        yield stream, pending
    finally:
        pending.cancel()
        await asyncio.gather(pending, return_exceptions=True)
        await stream.aclose()
    assert not service._subscribers


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
    assert state == {
        "seq": 0,
        "entities": [
            {
                "id": "e1",
                "parent_id": "",
                "type_name": "TestConfigEntity",
                "name": "hello",
                "value": "world",
            }
        ],
    }


def test_store_change_create():
    store, sss = _make_wired_store_and_sss()

    e = TestConfigEntity(id="e1", name="hello", value="world")
    delta = Delta.from_changes([Change.create(e)])
    store.apply_delta(delta)

    assert sss.seq == 1
    assert list(sss.delta_log) == [(1, delta.asdict())]
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
    assert found is not None
    assert found.name == "updated"


@pytest.mark.asyncio
async def test_subscribe_replays_missed():
    """Subscribe with after=0 after some changes should replay them."""
    store, sss = _make_wired_store_and_sss()
    entity = TestConfigEntity(id="e1", name="hello", value="world")
    delta = Delta.from_changes([Change.create(entity)])
    store.apply_delta(delta)
    async with aclosing(sss.subscribe(after=0)) as stream:
        assert await asyncio.wait_for(anext(stream), 1) == (1, delta.asdict())
    assert not sss._subscribers


@pytest.mark.asyncio
async def test_subscribe_streams_new():
    """Subscribe then apply changes — subscriber should receive them."""
    store, sss = _make_wired_store_and_sss()
    entity = TestConfigEntity(id="e1", name="hello", value="world")
    delta = Delta.from_changes([Change.create(entity)])
    async with _live_subscription(sss) as (_, pending):
        store.apply_delta(delta)
        assert await asyncio.wait_for(pending, 1) == (1, delta.asdict())


@pytest.mark.asyncio
async def test_subscribe_stale():
    """Subscribe with a too-old after value yields the STALE sentinel."""
    store, sss = _make_wired_store_and_sss(buffer_size=2)
    for i in range(3):
        store.insert_one(TestConfigEntity(id=f"e{i}", name=f"name{i}", value=f"val{i}"))
    async with aclosing(sss.subscribe(after=0)) as stream:
        assert await asyncio.wait_for(anext(stream), 1) is STALE
        with pytest.raises(StopAsyncIteration):
            await asyncio.wait_for(anext(stream), 1)
    assert not sss._subscribers


@pytest.mark.asyncio
async def test_subscribers_notified_on_store_change():
    """Multiple deltas are streamed to the subscriber in order."""
    store, sss = _make_wired_store_and_sss()
    first = Delta.from_changes(
        [
            Change.create(TestConfigEntity(id="e1", name="from_a", value="v1")),
        ]
    )
    second = Delta.from_changes(
        [
            Change.create(TestConfigEntity(id="e2", name="from_b", value="v2")),
        ]
    )
    async with _live_subscription(sss) as (stream, pending):
        store.apply_delta(first)
        store.apply_delta(second)
        assert await asyncio.wait_for(pending, 1) == (1, first.asdict())
        assert await asyncio.wait_for(anext(stream), 1) == (2, second.asdict())
