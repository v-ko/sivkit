# Changelog

## 0.11.0 - 2026-09-25

- Added `registerRootActionChangesHandler` and `registerProjection` (one per store; the projector gets the delta and the store).
- Added `store.requireAction`: mutations outside an action throw.
- Added `ProjectedViewState`; only creatable/writable in a projection.
- Breaking: `onChanges` / `on_changes` → `addOnChangesCallback`.
- Breaking (py): `InMemoryStore` is bound to one thread.
- A throwing store callback rolls back the change.
