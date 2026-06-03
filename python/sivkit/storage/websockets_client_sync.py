"""Client-side WebSocket sync using the ``websockets`` library.

Provides a TS-style lifecycle: ``connect()`` returns once the handshake is
done (store hydrated, loops running). Background tasks continue until the
connection drops or ``stop()`` is called.
"""

from __future__ import annotations

import asyncio
import json
import logging

from sivkit.storage.base_store import Store
from sivkit.storage.websocket_sync_service import WebSocketSyncService

log = logging.getLogger(__name__)

try:
    import websockets
    import websockets.exceptions
except ImportError as _exc:
    raise ImportError(
        "websockets_client_sync requires the websockets library. "
        "Install it with: pip install websockets"
    ) from _exc


class WebSocketsClientSync:
    """Client-side: owns a websockets connection (TS-style lifecycle).

    - ``connect()`` — opens WS, does handshake, returns once ready.
      Loops run in a background task.
    - ``stop()`` — tears down connection and background tasks.
    - ``done`` — Future that resolves when the connection ends.
    """

    def __init__(
        self,
        url: str,
        store: Store,
        role: str = "receiver",
        **kwargs,
    ) -> None:
        self._url = url
        self._store = store
        self._sync = WebSocketSyncService(
            store, role=role, on_ready=self._resolve_ready, **kwargs
        )
        self._task: asyncio.Task | None = None
        self._ready: asyncio.Future[None] | None = None
        self._done: asyncio.Future[None] | None = None

    @property
    def sync_service(self) -> WebSocketSyncService:
        return self._sync

    @property
    def done(self) -> asyncio.Future[None]:
        """Resolves when the connection ends (disconnect or error)."""
        if self._done is None:
            raise RuntimeError("Not connected")
        return self._done

    async def connect(self, timeout: float = 5.0) -> None:
        """Connect + handshake. Returns once the store is hydrated and loops are running.

        Raises on connection failure or handshake timeout.
        """
        loop = asyncio.get_running_loop()
        self._ready = loop.create_future()
        self._done = loop.create_future()
        self._task = asyncio.create_task(self._run())
        # Wait for handshake or propagate connection error
        try:
            await asyncio.wait_for(self._ready, timeout=timeout)
        except asyncio.TimeoutError:
            # Clean up the background task
            if self._task and not self._task.done():
                self._task.cancel()
            raise

    def stop(self) -> None:
        """Cancel the background sync task and close the connection."""
        if self._task and not self._task.done():
            self._task.cancel()

    def _resolve_ready(self) -> None:
        if self._ready and not self._ready.done():
            self._ready.set_result(None)

    async def _run(self) -> None:
        try:
            async with websockets.connect(self._url) as ws:

                async def send(msg: dict) -> None:
                    try:
                        await ws.send(json.dumps(msg))
                    except websockets.exceptions.ConnectionClosed:
                        raise asyncio.CancelledError

                async def receive() -> dict:
                    try:
                        raw = await ws.recv()
                    except websockets.exceptions.ConnectionClosed as exc:
                        raise asyncio.CancelledError from exc
                    return json.loads(raw)

                await self._sync.run(send, receive)
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            # Reject ready future if handshake never completed
            if self._ready and not self._ready.done():
                self._ready.set_exception(exc)
                return
            log.error("WebSocketsClientSync connection error: %s", exc)
        finally:
            if self._done and not self._done.done():
                self._done.set_result(None)
