import time

import pytest
from starlette.applications import Starlette
from starlette.routing import WebSocketRoute
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from sivkit.storage.in_memory_store import InMemoryStore
from sivkit.storage.starlette_sync import (
    SESSION_ACTIVE_CLOSE_CODE,
    StarletteSyncEndpoint,
)
from sivkit.storage.websocket_sync_service import WebSocketSyncService


def _client(sync: WebSocketSyncService) -> TestClient:
    async def ws(websocket):
        await StarletteSyncEndpoint(sync_service=sync).serve(websocket)

    return TestClient(Starlette(routes=[WebSocketRoute("/ws", ws)]))


def _close(session, sync: WebSocketSyncService) -> None:
    # TestClient cancels the handler on exit, racing the disconnect; let the session end first.
    session.close()
    while sync.running:
        time.sleep(0.001)


def test_second_session_is_refused_while_first_is_active():
    sync = WebSocketSyncService(InMemoryStore(), role="authority")
    client = _client(sync)
    with client.websocket_connect("/ws") as first:
        assert first.receive_json()["type"] == "full_state"
        with client.websocket_connect("/ws") as second:
            with pytest.raises(WebSocketDisconnect) as exc:
                second.receive_json()
            assert exc.value.code == SESSION_ACTIVE_CLOSE_CODE
        _close(first, sync)


def test_new_session_is_accepted_after_the_previous_one_closes():
    sync = WebSocketSyncService(InMemoryStore(), role="authority")
    client = _client(sync)
    with client.websocket_connect("/ws") as first:
        assert first.receive_json()["type"] == "full_state"
        _close(first, sync)
    with client.websocket_connect("/ws") as second:
        assert second.receive_json()["type"] == "full_state"
        _close(second, sync)
