"""Tests for WebSocketSyncService and WebSocketsClientSync subclass."""

import asyncio

import pytest

from sivkit import Entity, entity_type
from sivkit.storage.in_memory_store import InMemoryStore
from sivkit.storage.websocket_sync_service import WebSocketSyncService


@entity_type
class SyncTestEntity(Entity):
    name: str = ""
    value: int = 0


async def _channel_pair():
    """Create a bidirectional in-memory channel (two queues)."""
    a_to_b: asyncio.Queue[dict] = asyncio.Queue()
    b_to_a: asyncio.Queue[dict] = asyncio.Queue()

    async def a_send(msg: dict) -> None:
        a_to_b.put_nowait(msg)

    async def a_receive() -> dict:
        return await b_to_a.get()

    async def b_send(msg: dict) -> None:
        b_to_a.put_nowait(msg)

    async def b_receive() -> dict:
        return await a_to_b.get()

    return (a_send, a_receive), (b_send, b_receive)


@pytest.mark.asyncio
async def test_authority_receiver_handshake():
    """Authority sends full_state, receiver hydrates."""
    authority_store = InMemoryStore()
    e = SyncTestEntity(id="e1", name="hello", value=42)
    authority_store.insert_one(e)

    receiver_store = InMemoryStore()

    authority = WebSocketSyncService(authority_store, role="authority")
    receiver = WebSocketSyncService(receiver_store, role="receiver")

    (a_send, a_recv), (b_send, b_recv) = await _channel_pair()

    ready_events = []
    receiver_ready = WebSocketSyncService(
        receiver_store, role="receiver", on_ready=lambda: ready_events.append(True)
    )

    async def run_authority():
        try:
            await authority.run(a_send, a_recv)
        except asyncio.CancelledError:
            pass

    async def run_receiver():
        try:
            await receiver_ready.run(b_send, b_recv)
        except asyncio.CancelledError:
            pass

    a_task = asyncio.create_task(run_authority())
    r_task = asyncio.create_task(run_receiver())

    # Give time for handshake
    await asyncio.sleep(0.05)

    # Receiver should have the entity now
    found = receiver_store.find_one(id="e1")
    assert found is not None
    assert found.name == "hello"
    assert found.value == 42

    # on_ready should have fired
    assert len(ready_events) == 1

    a_task.cancel()
    r_task.cancel()
    await asyncio.gather(a_task, r_task, return_exceptions=True)


@pytest.mark.asyncio
async def test_bidirectional_delta_sync():
    """Changes on either side propagate to the other."""
    authority_store = InMemoryStore()
    receiver_store = InMemoryStore()

    authority = WebSocketSyncService(authority_store, role="authority")
    receiver = WebSocketSyncService(receiver_store, role="receiver")

    (a_send, a_recv), (b_send, b_recv) = await _channel_pair()

    async def run_authority():
        try:
            await authority.run(a_send, a_recv)
        except asyncio.CancelledError:
            pass

    async def run_receiver():
        try:
            await receiver.run(b_send, b_recv)
        except asyncio.CancelledError:
            pass

    a_task = asyncio.create_task(run_authority())
    r_task = asyncio.create_task(run_receiver())

    await asyncio.sleep(0.05)

    # Authority inserts → should appear on receiver
    e = SyncTestEntity(id="e2", name="from-authority", value=10)
    authority_store.insert_one(e)
    await asyncio.sleep(0.05)

    found = receiver_store.find_one(id="e2")
    assert found is not None
    assert found.name == "from-authority"

    # Receiver inserts → should appear on authority
    e2 = SyncTestEntity(id="e3", name="from-receiver", value=20)
    receiver_store.insert_one(e2)
    await asyncio.sleep(0.05)

    found2 = authority_store.find_one(id="e3")
    assert found2 is not None
    assert found2.name == "from-receiver"

    a_task.cancel()
    r_task.cancel()
    await asyncio.gather(a_task, r_task, return_exceptions=True)


@pytest.mark.asyncio
async def test_run_raises_if_already_running():
    """Calling run() on an already-running WSSS raises RuntimeError."""
    store = InMemoryStore()
    sync = WebSocketSyncService(store, role="authority")

    (a_send, a_recv), (b_send, b_recv) = await _channel_pair()

    async def run_sync():
        try:
            await sync.run(a_send, a_recv)
        except asyncio.CancelledError:
            pass

    task = asyncio.create_task(run_sync())
    await asyncio.sleep(0.02)

    with pytest.raises(RuntimeError, match="already-running"):
        await sync.run(b_send, b_recv)

    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
