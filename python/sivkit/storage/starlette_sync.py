"""Server-side WebSocket sync endpoint for Starlette/FastAPI."""

from __future__ import annotations

import logging
from typing import Any

from sivkit.storage.base_store import Store
from sivkit.storage.websocket_sync_service import WebSocketSyncService

log = logging.getLogger(__name__)

# WebSocket close code sent when the sync service already serves a client.
SESSION_ACTIVE_CLOSE_CODE = 4409

try:
    from starlette.websockets import WebSocket, WebSocketDisconnect
except ImportError as _exc:
    raise ImportError(
        "starlette_sync requires starlette. Install it with: pip install starlette"
    ) from _exc


class StarletteSyncEndpoint:
    """Server-side: wraps a Starlette/FastAPI WebSocket.

    Two modes:
    - Create WSSS internally: StarletteSyncEndpoint(store, role="authority")
    - Accept existing WSSS:   StarletteSyncEndpoint(sync_service=existing_wsss)
    """

    def __init__(
        self,
        store: Store | None = None,
        role: str = "authority",
        *,
        sync_service: WebSocketSyncService | None = None,
        **kwargs: Any,
    ) -> None:
        if sync_service is not None:
            self._sync = sync_service
        elif store is not None:
            self._sync = WebSocketSyncService(store, role=role, **kwargs)
        else:
            raise ValueError("Provide either store or sync_service")

    @property
    def sync_service(self) -> WebSocketSyncService:
        return self._sync

    async def serve(self, websocket: WebSocket) -> None:
        """Accept, adapt, run. Catches WebSocketDisconnect."""
        await websocket.accept()
        # Accept before closing so the client receives the close code.
        if self._sync.running:
            await websocket.close(
                code=SESSION_ACTIVE_CLOSE_CODE, reason="Another session is active"
            )
            return

        async def send(msg: dict) -> None:
            await websocket.send_json(msg)

        async def receive() -> dict:
            return await websocket.receive_json()

        try:
            await self._sync.run(send, receive)
        except* WebSocketDisconnect:
            pass
