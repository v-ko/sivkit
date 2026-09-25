import { Change } from "../../model/Change";
import { Entity, EntityData, SerializedEntityData, dumpToDict, loadFromDict, transformedEntity } from "../../model/Entity";
import { Delta } from "../../model/Delta";
import { assertInAction } from "../../registries/Action";

// a searchFilter is a dict, where there can be an id, a parent_id, a type or any other property
export interface SearchFilter {
    id?: string;
    parentId?: string;
    [key: string]: any;
}

export interface SerializedStoreData {
    entities: SerializedEntityData[];
}

export class IrrationalStorageOperation extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'IrrationalStorageOperation';
    }
}

export type OnChangesCallback = (delta: Delta, origin?: string) => void;

export abstract class Store {
    /** When set, notifying operations must run inside an action (checked before the change). */
    requireAction: boolean = false;
    protected _applyingInternally: boolean = false;
    private _onChangesCallbacks: OnChangesCallback[] = [];

    /** Callbacks run synchronously, in registration order. */
    addOnChangesCallback(callback: OnChangesCallback): void {
        this._onChangesCallbacks.push(callback);
    }

    removeOnChangesCallback(callback: OnChangesCallback): void {
        this._onChangesCallbacks = this._onChangesCallbacks.filter(c => c !== callback);
    }

    protected _assertInActionIfRequired(): void {
        if (this.requireAction) {
            assertInAction();
        }
    }

    /**
     * Fire the on-changes callbacks; if any throws, undo this call's changes,
     * pass the reversed delta to the callbacks that already saw them, and
     * rethrow. Atomicity across separate store calls is the caller's concern.
     */
    protected _fireOnChangesWithRollback(delta: Delta, origin?: string): void {
        const notified: OnChangesCallback[] = [];
        try {
            for (const callback of [...this._onChangesCallbacks]) {
                callback(delta, origin);
                notified.push(callback);
            }
        } catch (error) {
            const wasApplying = this._applyingInternally;
            this._applyingInternally = true;
            try {
                const changes = Array.from(delta.changes());
                for (let i = changes.length - 1; i >= 0; i--) {
                    this._applyChangeCore(changes[i].reversed());
                }
            } finally {
                this._applyingInternally = wasApplying;
            }
            const reversed = delta.reversed();
            for (const callback of notified) {
                callback(reversed, origin);
            }
            throw error;
        }
    }

    abstract insertOne(entity: Entity<EntityData>): Change;

    abstract find(filter: SearchFilter): Generator<Entity<EntityData>>;

    abstract findOne(filter: SearchFilter): Entity<EntityData> | undefined;

    abstract updateOne(entity: Entity<EntityData>): Change;

    abstract removeOne(entity: Entity<EntityData>): Change;

    // Batch operations (inefficient implementations)
    insert(entities: Entity<EntityData>[]): Change[] {
        return entities.map(entity => this.insertOne(entity))
    }
    remove(entities: Entity<EntityData>[]): Change[] {
        return entities.map(entity => this.removeOne(entity))
    }
    update(entities: Entity<EntityData>[]): Change[] {
        return entities.map(entity => this.updateOne(entity))
    }
    /** Apply a single change, firing the callbacks with the given origin. */
    applyChange(change: Change, origin?: string): Change {
        this._assertInActionIfRequired();
        this._applyingInternally = true;
        let appliedChange: Change;
        try {
            appliedChange = this._applyChangeCore(change);
        } finally {
            this._applyingInternally = false;
        }
        if (!appliedChange.isEmpty()) {
            this._fireOnChangesWithRollback(Delta.fromChanges([appliedChange]), origin);
        }
        return appliedChange;
    }

    protected _applyChangeCore(change: Change): Change {
        if (change.isCreate()) {
            let entityState = loadFromDict(change.forwardComponent as SerializedEntityData);
            return this.insertOne(entityState);
        } else if (change.isUpdate()) {
            let entity = this.findOne({ id: change.entityId });
            if (entity === undefined) {
                throw new IrrationalStorageOperation(`Last state retreival error for ${change.data} (type update)`);
            }
            entity = transformedEntity(entity, change);
            return this.updateOne(entity);
        } else if (change.isDelete()) {
            let entity = this.findOne({ id: change.entityId });
            if (entity === undefined) {
                throw new IrrationalStorageOperation(`Last state retreival error for ${change.data} (type delete)`);
            }
            return this.removeOne(entity);
        }
        return change;
    }

    data(): SerializedStoreData {
        const entities = Array.from(this.find({}));
        return { entities: entities.map(entity => dumpToDict(entity)) };
    }

    abstract clear(): void;

    protected _loaded: boolean = false;

    /** Load initial data into an empty (or cleared) store. Can only be called once, or again after clear(). */
    loadData(entities: Entity<EntityData>[], _origin?: string): Delta {
        if (this._loaded) {
            throw new Error('Store already has data loaded. Call clear() before loading again.');
        }
        this._applyingInternally = true;
        const changes: Change[] = [];
        try {
            for (const entity of entities) {
                changes.push(this.insertOne(entity));
            }
        } finally {
            this._applyingInternally = false;
            this._loaded = true;
        }

        return Delta.fromChanges(changes);
    }

    /** Apply a delta, firing the callbacks once at the end with the given origin. */
    applyDelta(delta: Delta, origin?: string, skipIrrationalOperations: boolean = false): Delta {
        this._assertInActionIfRequired();
        this._applyingInternally = true;

        const appliedDelta = new Delta({});
        try {
            for (const change of delta.changes()) {
                try {
                    const appliedChange = this._applyChangeCore(change);
                    appliedDelta.addChange(appliedChange);
                } catch (error) {
                    if (!skipIrrationalOperations || !(error instanceof IrrationalStorageOperation)) {
                        throw error;
                    }
                }
            }
        } finally {
            this._applyingInternally = false;
        }

        if (!appliedDelta.isEmpty()) {
            this._fireOnChangesWithRollback(appliedDelta, origin);
        }
        return appliedDelta;
    }
}
