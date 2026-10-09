"""Tests for WebSocket store synchronization and server-wins conflicts."""

import asyncio
from contextlib import asynccontextmanager
from copy import deepcopy

import pytest

from sivkit import Entity, entity_type
from sivkit.storage.delta import Delta
from sivkit.storage.in_memory_store import InMemoryStore
from sivkit.storage.websocket_sync_service import WebSocketSyncService


@entity_type
class SyncTestEntity(Entity):
    name: str = ""
    value: int = 0


@pytest.mark.parametrize(
    "client_reverse,client_forward,server_reverse,server_forward,expected",
    [
        (
            {"name": "old"},
            {"name": "client"},
            {"name": "old"},
            {},
            {"e": ["e", {"name": "client"}, {}]},
        ),
        (
            {"name": "old"},
            {},
            {"name": "old"},
            {"name": "server"},
            {"e": ["e", {}, {"name": "server"}]},
        ),
        (
            {"name": None},
            {},
            {"name": None},
            {"name": "server"},
            {"e": ["e", {}, {"name": "server"}]},
        ),
        ({}, {"name": None}, {"name": "old"}, {}, {"e": ["e", {"name": None}, {}]}),
        ({"name": "old"}, {}, {}, {"name": None}, {"e": ["e", {}, {"name": None}]}),
        ({"name": "old"}, {}, {"name": "old"}, {}, None),
    ],
    ids=[
        "server removes",
        "client removes",
        "client removes null",
        "server removes client null",
        "server adds null",
        "both remove",
    ],
)
def test_ot_conflicts_preserve_field_presence(
    client_reverse, client_forward, server_reverse, server_forward, expected
):
    sync = WebSocketSyncService(InMemoryStore(), role="authority")
    client = Delta.from_data(
        {"e": ["e", {**client_reverse, "value": 0}, {**client_forward, "value": 1}]}
    )
    original = deepcopy(client.asdict())
    server = Delta.from_data({"e": ["e", server_reverse, server_forward]})
    transformed = sync._transform_client_delta(client, server)
    assert transformed.asdict() == {"e": ["e", {"value": 0}, {"value": 1}]}
    correction = sync._compute_correction(client, transformed, server)
    assert (correction.asdict() if correction is not None else None) == expected
    assert client.asdict() == original


@pytest.mark.asyncio
async def test_stale_delta_reconciles_server_wins_conflicts(monkeypatch):
    entity_id = "e"
    store = InMemoryStore()
    store.insert_one(SyncTestEntity(id=entity_id, name="server", value=0))
    sync = WebSocketSyncService(store, role="authority")
    sync._seq = 1
    sync._delta_history[1] = {
        entity_id: [entity_id, {"name": "old"}, {"name": "server"}]
    }
    corrections = []
    sent = []
    monkeypatch.setattr(
        sync, "push_delta", lambda delta: corrections.append(delta.asdict())
    )

    async def send(message):
        sent.append(message)

    await sync._handle_remote_delta(
        {
            "type": "delta",
            "seq": 2,
            "base_seq": 0,
            "delta": {
                entity_id: [
                    entity_id,
                    {"name": "old", "value": 0},
                    {"name": "client", "value": 1},
                ]
            },
        },
        send,
    )
    entity = store.find_one(id=entity_id)
    assert entity is not None
    assert entity.name == "server"
    assert entity.value == 1
    assert sent == [{"type": "ack", "seq": 2}]
    assert corrections == [
        {entity_id: [entity_id, {"name": "client"}, {"name": "server"}]}
    ]


def _channel_pair():
    """Create a bidirectional in-memory transport using two queues."""
    a_to_b: asyncio.Queue[dict] = asyncio.Queue()
    b_to_a: asyncio.Queue[dict] = asyncio.Queue()

    async def a_send(message):
        a_to_b.put_nowait(message)

    async def b_send(message):
        b_to_a.put_nowait(message)

    return (a_send, b_to_a.get), (b_send, a_to_b.get)


@pytest.fixture
def connected_pair():
    @asynccontextmanager
    async def connect(authority_store, receiver_store):
        authority_ready = asyncio.Event()
        receiver_ready = asyncio.Event()
        authority = WebSocketSyncService(
            authority_store,
            role="authority",
            on_ready=authority_ready.set,
        )
        receiver = WebSocketSyncService(
            receiver_store,
            role="receiver",
            on_ready=receiver_ready.set,
        )
        (a_send, a_receive), (r_send, r_receive) = _channel_pair()
        tasks = [
            asyncio.create_task(authority.run(a_send, a_receive)),
            asyncio.create_task(receiver.run(r_send, r_receive)),
        ]
        try:
            await asyncio.wait_for(
                asyncio.gather(authority_ready.wait(), receiver_ready.wait()),
                timeout=1,
            )
            yield authority, receiver
        finally:
            for task in tasks:
                task.cancel()
            results = await asyncio.gather(*tasks, return_exceptions=True)
            for result in results:
                if isinstance(result, BaseException) and not isinstance(
                    result, asyncio.CancelledError
                ):
                    raise result

    return connect


@pytest.mark.asyncio
async def test_authority_receiver_handshake(connected_pair):
    """Authority sends full_state, receiver hydrates before on_ready."""
    authority_store = InMemoryStore()
    authority_store.insert_one(SyncTestEntity(id="e1", name="hello", value=42))
    receiver_store = InMemoryStore()

    async with connected_pair(authority_store, receiver_store):
        found = receiver_store.find_one(id="e1")
        assert found is not None
        assert found.name == "hello"
        assert found.value == 42


@pytest.mark.asyncio
async def test_bidirectional_delta_sync(connected_pair):
    """Changes on either side propagate before their ACK resolves."""
    authority_store = InMemoryStore()
    receiver_store = InMemoryStore()

    async with connected_pair(authority_store, receiver_store) as (authority, receiver):
        authority_store.insert_one(
            SyncTestEntity(id="e2", name="from-authority", value=10)
        )
        await asyncio.wait_for(asyncio.shield(authority.last_push_future), timeout=1)
        found = receiver_store.find_one(id="e2")
        assert found is not None
        assert found.name == "from-authority"

        receiver_store.insert_one(
            SyncTestEntity(id="e3", name="from-receiver", value=20)
        )
        await asyncio.wait_for(asyncio.shield(receiver.last_push_future), timeout=1)
        found = authority_store.find_one(id="e3")
        assert found is not None
        assert found.name == "from-receiver"


@pytest.mark.asyncio
async def test_run_raises_if_already_running(connected_pair):
    """Each service supports only one concurrent connection."""
    async with connected_pair(InMemoryStore(), InMemoryStore()) as (authority, _):
        (send, receive), _ = _channel_pair()
        with pytest.raises(RuntimeError, match="already-running"):
            await authority.run(send, receive)
