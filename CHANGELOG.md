# Changelog

## 0.12.0 - 2026-10-04

- Guideline: SQLAlchemy instead of peewee (`docs/adr/101`).
- (py) `SqliteVcsAdapter` uses SQLAlchemy, one engine per adapter; existing databases open unchanged. Added `delete_snapshot` and `create_sqlite_engine`.
- (py) The Qt asyncio loop is now qasync, via the same `install()` / `QtMainLoop`. `QtAsyncEventLoop` removed; `uninstall()` added for tests.
- `registerProjection` accepts `Store` subclasses.
- WebSocket sync: a second client is closed with 4409 (`SESSION_ACTIVE_CLOSE_CODE`); (ts) `WebSocketClosedError` before the handshake; (py) outbound queue per session.
- (ts) Storage addons: `onCommitted(commit)` runs in the commit lock after each local commit, before the squash; `StorageService.sendToAddon(projectId, addonName, message)` reaches `onMessage`. `ProjectStorageManager.addAddon` now takes the addon's name.

## 0.11.0 - 2026-09-25

- Added `registerRootActionChangesHandler` and `registerProjection` (one per store; the projector gets the delta and the store).
- Added `store.requireAction`: mutations outside an action throw.
- Added `ProjectedViewState`; only creatable/writable in a projection.
- Breaking: `onChanges` / `on_changes` → `addOnChangesCallback`.
- Breaking (py): `InMemoryStore` is bound to one thread.
- A throwing store callback rolls back the change.
