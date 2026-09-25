import { runInAction } from "mobx";
import { Delta } from "../model/Delta";
import type { Store } from "../storage/domain-store/BaseStore";
import { registerRootActionChangesHandler } from "./Action";

export type Projector = (delta: Delta, store: Store) => void;

// Projectors are the sole writers of projection-managed view state. They run as
// plain mobx actions (no sivkit action frame), so this module tracks its own
// scope instead of piggybacking on the action call stack.
let _inProjection = false;
const _projections = new Map<Store, () => void>();

export function isInProjection(): boolean {
    return _inProjection;
}

export function assertInProjection(): void {
    if (!_inProjection) {
        throw new Error(
            'Projection-managed view state can only be mutated inside a projector'
        );
    }
}

/** Run fn as a mobx action within projection scope. */
export function runInProjection<T>(fn: () => T): T {
    const wasInProjection = _inProjection;
    _inProjection = true;
    try {
        return runInAction(fn);
    } finally {
        _inProjection = wasInProjection;
    }
}

/**
 * Register the store's projector (one per store). At each root action's end the
 * projector gets the action's store changes merged into one delta (possibly
 * empty) and the store, inside projection scope. Returns an unregister function.
 */
export function registerProjection(store: Store, projector: Projector): () => void {
    if (_projections.has(store)) {
        throw new Error('A projection is already registered for this store');
    }
    const unregisterHandler = registerRootActionChangesHandler(store, (_rootAction, changes) => {
        const delta = new Delta({});
        for (const change of changes) {
            delta.mergeWithPriority(change.delta.copy());
        }
        runInProjection(() => projector(delta, store));
    });
    const unregister = () => {
        unregisterHandler();
        _projections.delete(store);
    };
    _projections.set(store, unregister);
    return unregister;
}

/**
 * Base for view state whose contents are written only by the projector. Both
 * creating the object and writing its fields are projection-managed: they must
 * happen inside a projector. Actions change primary state (e.g. selection); the
 * projector derives these objects from it.
 */
export abstract class ProjectedViewState {
    constructor() {
        assertInProjection();
    }
}
