"""Bidirectional WebSocket store synchronization.

Roles
-----
- **authority**: owns the canonical state; sends ``full_state`` on connect.
- **receiver**: expects ``full_state`` on connect; applies it to its store.

Sync modes
----------
- **OT** (default): Both sides may write. Authority is the sequencer.
  On conflict (receiver's base_seq < authority's seq), the authority
  transforms the receiver's delta via delta arithmetic (server-wins on
  conflicting fields) and pushes a correction delta to the receiver.
  The receiver sees: ACK + normal remote delta (no special client logic).

- **REJECT**: Receiver sends base_seq with each delta. Authority accepts
  if base_seq == current seq, otherwise responds with a ``reject`` message.
  Receiver must re-read state and retry. Simple, no transform.

- **LOCKING**: Only the lock-holder may push deltas. Authority holds the
  lock by default. Receiver must request and be granted the lock before
  mutating. Requires a LockableStore interface.

Wire protocol (JSON)::

    {"type": "full_state", "seq": <int>, "entities": [...]}
    {"type": "delta",      "seq": <int>, "base_seq": <int>, "delta": {DeltaData}}
    {"type": "ack",        "seq": <int>}
    {"type": "reject",     "seq": <int>, "server_seq": <int>}  (REJECT mode)

Store interaction
-----------------
- Authority builds ``full_state`` via ``store.find()``.
- Receiver hydrates via ``store.clear()`` + ``store.load_data()``.
  ``load_data`` does **not** fire the on-changes callbacks, so only real
  user-action deltas reach change listeners.
- Both sides apply remote deltas with ``store.apply_delta(delta,
  origin='remote')``, inside a service action if the store requires one.

Transport-agnostic: the caller supplies async ``send``/``receive``
callables, so it works with any WebSocket library.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from enum import Enum
from typing import Any

from sivkit.libs.action import action
from sivkit.libs.model import dump_to_dict, load_from_dict
from sivkit.storage.base_store import Store
from sivkit.storage.change import Change
from sivkit.storage.delta import Delta, DeltaData

log = logging.getLogger(__name__)


@action("sync.apply_remote_delta", issuer="service")
def _apply_remote_delta_in_action(store: Store, delta: Delta) -> None:
    store.apply_delta(delta, origin="remote")


# Type aliases for the transport callables.
SendFn = Callable[[dict[str, Any]], Awaitable[None]]
ReceiveFn = Callable[[], Awaitable[dict[str, Any]]]

ACK_TIMEOUT = 5.0  # seconds


class SyncMode(Enum):
    """Conflict-resolution strategy for bidirectional sync.

    OT:      Authority transforms conflicting receiver deltas using delta
             arithmetic (server-wins). Receiver sees corrections as normal
             remote deltas — no special client logic needed.

    REJECT:  Authority rejects receiver deltas with stale base_seq.
             Receiver must re-read state and retry. Simple, no transform.

    LOCKING: Only the lock-holder may push deltas. Authority holds the lock
             by default. Receiver must acquire the lock before writing.
             Requires a LockableStore (store.lock() / store.unlock()).
    """

    OT = "ot"
    REJECT = "reject"
    LOCKING = "locking"


class ProtocolError(Exception):
    """Raised on protocol-level errors during the WebSocket sync."""


class WebSocketSyncService:
    """Bidirectional store sync over a WebSocket connection.

    Usage (authority, OT mode — default)::

        sync = WebSocketSyncService(store, role='authority', mode=SyncMode.OT)
        await sync.run(ws_send, ws_receive)

    Usage (receiver)::

        sync = WebSocketSyncService(store, role='receiver', mode=SyncMode.OT)
        await sync.run(ws_send, ws_receive)
    """

    def __init__(
        self,
        store: Store,
        role: str,  # 'authority' | 'receiver'
        mode: SyncMode = SyncMode.OT,
        on_ready: Callable[[], None] | None = None,
    ) -> None:
        if role not in ("authority", "receiver"):
            raise ValueError(f"role must be 'authority' or 'receiver', got {role!r}")

        self._store = store
        self.role = role
        self.mode = mode
        self._on_ready = on_ready

        self._seq: int = 0
        # Recreated per session: a queue is bound to the loop that first awaits it.
        self._outbound: asyncio.Queue[
            tuple[int, int, DeltaData, asyncio.Future[None]]
        ] = asyncio.Queue()
        self._pending_acks: dict[int, asyncio.Future[None]] = {}
        self._last_push_future: asyncio.Future[None] | None = None
        self.running = False
        self._loop: asyncio.AbstractEventLoop | None = None

        # Delta history for OT: seq -> DeltaData (authority only, for transform)
        self._delta_history: dict[int, DeltaData] = {}
        # Track the receiver's last acknowledged seq (authority side)
        self._receiver_acked_seq: int = 0

    # ------------------------------------------------------------------
    # Outbound
    # ------------------------------------------------------------------

    @property
    def last_push_future(self) -> asyncio.Future[None] | None:
        """The Future from the most recent push_delta call. Await to confirm ACK."""
        return self._last_push_future

    def push_delta(self, delta: Delta) -> asyncio.Future[None]:
        """Enqueue a delta for sending. Returns a Future that resolves on ACK.

        Fire-and-forget is fine — ignore the returned future if you don't
        need ACK confirmation. Must be called from the event loop thread.
        """
        base_seq = self._seq
        self._seq += 1
        seq = self._seq

        future: asyncio.Future[None]
        if self._loop is not None:
            future = self._loop.create_future()
        else:
            future = asyncio.get_event_loop().create_future()

        if not self.running:
            future.cancel()
            return future

        delta_data = delta.asdict()
        self._outbound.put_nowait((seq, base_seq, delta_data, future))

        # Authority tracks its own deltas for OT transform
        if self.role == "authority" and self.mode == SyncMode.OT:
            self._delta_history[seq] = delta_data

        self._last_push_future = future
        return future

    # ------------------------------------------------------------------
    # Main loop
    # ------------------------------------------------------------------

    async def run(self, send: SendFn, receive: ReceiveFn) -> None:
        """Run the sync protocol on an established connection.

        Automatically wires the store's on_changes callback to push local
        deltas outbound (skipping remote-origin). The callback is removed
        on exit.

        Blocks until the connection is closed or an unrecoverable error
        occurs.

        Args:
            send:    Async callable — send a JSON-serialisable dict.
            receive: Async callable — return the next parsed JSON message.
        """
        if self.running:
            raise RuntimeError(
                "run() called on an already-running WebSocketSyncService. "
                "Each instance supports only one concurrent connection."
            )

        self._loop = asyncio.get_running_loop()
        self._outbound = asyncio.Queue()
        self.running = True

        def _outbound(delta: Delta, origin: str | None = None) -> None:
            if origin == "remote" or not self.running:
                return
            self.push_delta(delta)

        self._store.add_on_changes_callback(_outbound)

        try:
            # --- Handshake ---
            if self.role == "authority":
                await send(self._full_state_message())
            else:
                msg = await receive()
                if msg.get("type") != "full_state":
                    raise ProtocolError(f"Expected full_state, got {msg.get('type')!r}")
                self._handle_full_state(msg)

            # Signal that handshake is complete and store is hydrated
            if self._on_ready is not None:
                self._on_ready()

            # --- Concurrent send + receive ---
            async with asyncio.TaskGroup() as tg:
                tg.create_task(self._send_loop(send))
                tg.create_task(self._receive_loop(send, receive))
        finally:
            self._store.remove_on_changes_callback(_outbound)
            self.running = False
            self._loop = None
            # Cancel pending ACKs so callers don't hang
            for future in self._pending_acks.values():
                if not future.done():
                    future.cancel()
            self._pending_acks.clear()
            # Unsent deltas are already in the next client's full_state.
            while not self._outbound.empty():
                *_, future = self._outbound.get_nowait()
                if not future.done():
                    future.cancel()

    # ------------------------------------------------------------------
    # Internal loops
    # ------------------------------------------------------------------

    async def _send_loop(self, send: SendFn) -> None:
        while self.running:
            try:
                seq, base_seq, delta_data, future = await self._outbound.get()
            except asyncio.CancelledError:
                break

            self._pending_acks[seq] = future

            try:
                await send(
                    {
                        "type": "delta",
                        "seq": seq,
                        "base_seq": base_seq,
                        "delta": delta_data,
                    }
                )
            except (asyncio.CancelledError, Exception):
                # Connection gone — cancel future and exit
                if not future.done():
                    future.cancel()
                self._pending_acks.pop(seq, None)
                break

            try:
                await asyncio.wait_for(asyncio.shield(future), timeout=ACK_TIMEOUT)
            except asyncio.CancelledError:
                # Task cancelled (connection closed) — clean exit
                break
            except asyncio.TimeoutError:
                log.error("ACK timeout for seq %d", seq)
                pa = self._pending_acks.pop(seq, None)
                if pa is not None and not pa.done():
                    pa.cancel()
                raise

    async def _receive_loop(
        self,
        send: SendFn,
        receive: ReceiveFn,
    ) -> None:
        try:
            while self.running:
                msg = await receive()
                msg_type = msg.get("type")

                if msg_type == "delta":
                    await self._handle_remote_delta(msg, send)

                elif msg_type == "ack":
                    future = self._pending_acks.pop(msg["seq"], None)
                    if future is not None and not future.done():
                        future.set_result(None)

                elif msg_type == "full_state":
                    self._handle_full_state(msg)

                elif msg_type == "reject":
                    # REJECT mode: authority refused our delta
                    log.warning(
                        "Delta seq %d rejected (server_seq=%d)",
                        msg.get("seq"),
                        msg.get("server_seq"),
                    )
                    future = self._pending_acks.pop(msg["seq"], None)
                    if future is not None and not future.done():
                        future.set_exception(
                            ProtocolError(f"Delta rejected: stale base_seq")
                        )

                else:
                    log.warning("Unknown WS message type: %s", msg_type)
        except asyncio.CancelledError:
            # Connection closed — exit gracefully
            pass

    async def _handle_remote_delta(self, msg: dict[str, Any], send: SendFn) -> None:
        """Process an incoming delta message based on the current sync mode."""
        remote_seq = msg["seq"]
        base_seq = msg.get("base_seq", 0)
        delta = Delta.from_data(msg["delta"])

        if self.role == "authority":
            if self.mode == SyncMode.OT:
                await self._handle_delta_ot(remote_seq, base_seq, delta, send)
            elif self.mode == SyncMode.REJECT:
                await self._handle_delta_reject(remote_seq, base_seq, delta, send)
            elif self.mode == SyncMode.LOCKING:
                raise NotImplementedError(
                    "LOCKING mode: Authority receives delta only from lock-holder. "
                    "Requires LockableStore with lock()/unlock() interface and "
                    "wire messages: lock_request, lock_granted, lock_denied, "
                    "lock_release, lock_revoke. Lock holder is tracked per-connection."
                )
        else:
            # Receiver: always apply remote deltas from authority
            self._apply_remote(delta)
            await send({"type": "ack", "seq": remote_seq})
            self._seq = max(self._seq, remote_seq)

    async def _handle_delta_ot(
        self,
        remote_seq: int,
        base_seq: int,
        client_delta: Delta,
        send: SendFn,
    ) -> None:
        """OT mode: transform client delta against concurrent server ops, apply,
        ACK, and push correction if needed.

        Algorithm:
        1. Compute server_ops = squash of all authority deltas since base_seq
        2. Transform client_delta: remove fields that server_ops already changed
           (server-wins on conflict)
        3. Apply transformed delta to store
        4. ACK the client's seq
        5. If conflicting client fields differ from server state, push a
           correction so the client converges (a normal remote delta)
        """
        # Collect server deltas that happened between base_seq and current seq
        server_ops = Delta()
        if base_seq < self._seq:
            for seq_i in range(base_seq + 1, self._seq + 1):
                hist = self._delta_history.get(seq_i)
                if hist is not None:
                    server_ops.merge_with_priority(Delta.from_data(hist))

        # Transform: for conflicting entities+fields, server wins (drop from client)
        transformed = self._transform_client_delta(client_delta, server_ops)

        # Apply the (possibly reduced) client delta
        if not transformed.is_empty():
            self._apply_remote(transformed)

        # ACK the client
        await send({"type": "ack", "seq": remote_seq})

        # Reconcile optimistic client conflicts with server state,
        # including fields the server removed.
        if not server_ops.is_empty():
            correction = self._compute_correction(client_delta, transformed, server_ops)
            if correction is not None and not correction.is_empty():
                self.push_delta(correction)

    def _transform_client_delta(self, client_delta: Delta, server_ops: Delta) -> Delta:
        """Transform client delta against server ops (server-wins).

        For each entity in the client delta: if the server also changed the
        same fields, drop those fields from the client delta (server wins).
        Additions and removals conflict just like changes to existing values.
        """
        if server_ops.is_empty():
            return client_delta

        result = client_delta.copy()
        for change in list(result.changes()):
            server_change = server_ops.change(change.entity_id)
            if server_change is None:
                continue

            # Server-wins includes removals (reverse-only fields), not just values.
            server_keys = (
                server_change.reverse_component.keys()
                | server_change.forward_component.keys()
            )
            new_forward = {
                k: v
                for k, v in change.forward_component.items()
                if k not in server_keys
            }
            new_reverse = {
                k: v
                for k, v in change.reverse_component.items()
                if k not in server_keys
            }
            change.forward_component = new_forward
            change.reverse_component = new_reverse

        # Remove empty changes
        for eid in list(result.entity_ids()):
            ch = result.change(eid)
            if ch is not None and ch.is_empty():
                result.remove_change(eid)

        return result

    def _compute_correction(
        self, original_client: Delta, transformed: Delta, server_ops: Delta
    ) -> Delta | None:
        """Compute a correction delta for fields the client applied optimistically
        but the server dropped due to conflict.

        The client receives it as a normal remote delta, replacing conflicting
        optimistic values or absence with the server's values or absence.
        Return None when no correction is needed.
        """
        correction = Delta()

        for change in original_client.changes():
            server_change = server_ops.change(change.entity_id)
            if server_change is None:
                continue

            # Additions and removals affect fields even when forward is empty.
            conflicting_keys = (
                change.reverse_component.keys() | change.forward_component.keys()
            ) & (
                server_change.reverse_component.keys()
                | server_change.forward_component.keys()
            )
            if not conflicting_keys:
                continue

            # Correction: client's optimistic state → server's state.
            # An omitted field represents absence, not a null value.
            reverse_component = {
                k: value
                for k, value in change.forward_component.items()
                if k in conflicting_keys
            }
            forward_component = {
                k: value
                for k, value in server_change.forward_component.items()
                if k in conflicting_keys
            }
            if reverse_component != forward_component:
                correction.add_change(
                    Change(change.entity_id, reverse_component, forward_component)
                )

        return correction if not correction.is_empty() else None

    async def _handle_delta_reject(
        self,
        remote_seq: int,
        base_seq: int,
        client_delta: Delta,
        send: SendFn,
    ) -> None:
        """REJECT mode: accept if base_seq matches, reject otherwise.

        On accept: apply delta, ACK.
        On reject: send reject message. Client must re-read and retry.
        """
        raise NotImplementedError(
            "REJECT mode: Authority accepts client delta only if "
            "base_seq == server's current seq. Otherwise sends "
            "{type: 'reject', seq: N, server_seq: M}. "
            "Client must handle rejection by re-reading state "
            "(via full_state request) and retrying the mutation."
        )

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _apply_remote(self, delta: Delta) -> None:
        if self._store.require_action:
            _apply_remote_delta_in_action(self._store, delta)
        else:
            self._store.apply_delta(delta, origin="remote")

    def _full_state_message(self) -> dict[str, Any]:
        entities = [dump_to_dict(e) for e in self._store.find()]
        return {"type": "full_state", "seq": self._seq, "entities": entities}

    def _handle_full_state(self, msg: dict[str, Any]) -> None:
        self._seq = msg.get("seq", 0)
        entities = [load_from_dict(d) for d in msg.get("entities", [])]
        self._store.clear()
        self._store.load_data(entities, origin="remote")
