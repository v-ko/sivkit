"""Server-side service for the store-sync protocol.

Listens to store changes (via ``on_changes``) and tracks them with a
monotonic seq counter and a delta ring buffer, broadcasting to SSE
subscribers.

The consumer wires this by chaining ``on_store_changes`` into the
store's ``on_changes`` callback.

This is the server-side counterpart to the TypeScript
``RestStoreSyncService`` in ``sivkit/typescript/src/storage/sync/``.
"""

from __future__ import annotations

import asyncio
import logging
from collections import deque
from collections.abc import AsyncGenerator

from sivkit.libs.model import dump_to_dict
from sivkit.storage.delta import Delta, DeltaData
from sivkit.storage.in_memory_store import InMemoryStore

log = logging.getLogger(__name__)


# Sentinel yielded when the client's ``after`` is too far behind the ring buffer.
STALE = object()


class StoreSyncService:
    """Generic server-side store-sync service.

    Public methods map to REST / SSE endpoints:

    * ``full_state()``       → ``GET  {endpoint}``
    * ``subscribe(after)``   → async generator of ``(seq, delta_data)`` tuples

    Wire ``on_store_changes`` as (part of) the store's ``on_changes``
    callback so that every mutation is automatically broadcast.
    """

    def __init__(self, store: InMemoryStore, buffer_size: int = 200) -> None:
        self.store = store
        self.delta_log: deque[tuple[int, DeltaData]] = deque(maxlen=buffer_size)
        self.seq: int = 0  # Sequential number of the last applied delta
        self._lock = asyncio.Lock()
        self._subscribers: set[asyncio.Queue] = set()

    def full_state(self) -> dict:
        entities = [dump_to_dict(e) for e in self.store.find()]
        return {"seq": self.seq, "entities": entities}

    def on_store_changes(self, delta: Delta, origin: str | None = None) -> None:
        """Record a delta and notify all SSE subscribers.

        Designed to be called from ``store.on_changes`` (synchronous).
        Subscriber queues are thread-safe for put_nowait from any thread.
        """
        delta_data = delta.asdict()
        self.seq += 1
        self.delta_log.append((self.seq, delta_data))

        for q in self._subscribers:
            q.put_nowait((self.seq, delta_data))

    # ------------------------------------------------------------------
    # subscribe — async generator of (seq, changes) | STALE
    # ------------------------------------------------------------------

    async def subscribe(
        self, after: int
    ) -> AsyncGenerator[tuple[int, DeltaData] | object]:
        """Async generator yielding ``(seq, delta_data)`` tuples.

        Replays missed deltas from the ring buffer, then streams new
        deltas as they arrive.  Yields the ``STALE`` sentinel (once) if
        the client's *after* is too far behind the ring buffer.
        """
        queue: asyncio.Queue = asyncio.Queue()
        self._subscribers.add(queue)
        try:
            # Check for stale
            if self.delta_log:
                oldest_seq = self.delta_log[0][0]
                if after < oldest_seq - 1:
                    yield STALE
                    return

            # Replay missed deltas from the ring buffer
            last_replayed = after
            for seq, delta_data in self.delta_log:
                if seq > after:
                    yield (seq, delta_data)
                    last_replayed = seq

            # Stream new deltas
            while True:
                seq, delta_data = await queue.get()
                if seq <= last_replayed:
                    continue
                yield (seq, delta_data)
                last_replayed = seq
        finally:
            self._subscribers.discard(queue)
