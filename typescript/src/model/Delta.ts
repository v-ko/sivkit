import { Change, ChangeData, ChangeType } from "./Change";
import { entityKeysAreEqual, type Entity, type EntityData } from "./Entity";

function changeReducesToNone(change: Change): boolean {
    if (change.isEmpty()) {
        return true;
    }
    if (!change.isUpdate()) {
        return false;
    }

    const reverseComponent: Record<string, any> = { ...change.reverseComponent };
    const forwardComponent: Record<string, any> = { ...change.forwardComponent };

    for (const key of Object.keys(reverseComponent)) {
        if (!(key in forwardComponent)) {
            continue;
        }
        if (entityKeysAreEqual(reverseComponent[key], forwardComponent[key])) {
            delete reverseComponent[key];
            delete forwardComponent[key];
        }
    }

    change.reverseComponent = reverseComponent;
    change.forwardComponent = forwardComponent;

    return Object.keys(reverseComponent).length === 0 && Object.keys(forwardComponent).length === 0;
}

export type DeltaData = {
    [key: string]: ChangeData;
}

/** Return updated data, preserving unrelated fields and field absence. */
function applyComponents(
    data: Record<string, any>,
    reverse: Record<string, any>,
    forward: Record<string, any>,
) {
    const result = { ...data };
    for (const key of Object.keys(reverse)) {
        if (!Object.prototype.hasOwnProperty.call(forward, key)) {
            delete result[key];
        }
    }
    return { ...result, ...forward };
}

/**
 * Changes to entities, with their before-state retained for undo.
 * Composition combines consecutive changes into a single net change.
 */
export class Delta {
    private _data: DeltaData = {};

    constructor(data: DeltaData) {
        this._data = data;
    }

    static fromChanges(changes: Change[]): Delta {
        let delta = new Delta({});
        for (const change of changes) {
            delta.addChange(change)
        }
        return delta;
    }

    static fromEntities(entities: Iterable<Entity<EntityData>>): Delta {
        return Delta.fromChanges(Array.from(entities, entity => Change.create(entity)));
    }

    get data(): DeltaData {
        return this._data;
    }

    setData(data: DeltaData) {
        this._data = data;
    }

    *changes(): Generator<Change> {
        for (const changeData of Object.values(this._data)) {
            yield new Change(changeData);
        }
    }

    copy() {
        return new Delta(structuredClone(this._data));
    }

    /** Return the inverse, preserving entry keys and sharing component data. */
    reversed(): Delta {
        const reversedData: DeltaData = {};
        for (const [key, [entityId, reverseComponent, forwardComponent]] of Object.entries(this._data)) {
            reversedData[key] = [entityId, forwardComponent, reverseComponent];
        }
        return new Delta(reversedData);
    }

    /** Adds a change to this delta (consumed — caller should not reuse it). */
    addChange(change: Change) {
        if (this._data[change.entityId] !== undefined) {
            this.mergeChangeWithPriority(change);
        } else {
            this._data[change.entityId] = change.data;
        }
    }

    removeChange(entityId: string) {
        if (this._data[entityId] === undefined) {
            throw Error('Entity delta with that key not found');
        }
        delete this._data[entityId];
    }

    isEmpty(): boolean {
        for (const [_, oldState, newState] of Object.values(this._data)) {
            if (Object.keys(oldState).length > 0 || Object.keys(newState).length > 0) {
                return false;
            }
        }
        return true;
    }

    entityIds(): string[] {
        return Object.keys(this._data);
    }

    changeData(entityId: string): ChangeData | undefined {
        return this._data[entityId];
    }

    change(entityId: string): Change | undefined{
        const changeData = this.changeData(entityId);
        if (changeData === undefined) {
            return undefined;
        }
        return new Change(changeData);
    }

    /**
     * Merge a new change into the existing delta for the same entity, in place.
     *
     * The result has the same effect as applying the existing change followed
     * by the new one. For affected fields, forward keeps the final state and
     * reverse keeps the earliest state, including field absence.
     *
     * Supported merge patterns:
     *  1) Update > Update: Combine updates, canceling fields restored to their old state
     *  2) Create > Update: Create with updated values and field removals
     *  3) Delete > Create: Update (old => new), or cancel if identical
     *  4) Create > Delete: The creation is canceled
     *  5) Update > Delete: Delete with the original state in reverse
     *
     * Empty on either side leaves the other change unchanged. Impossible
     * lifecycle sequences, such as Create > Create, throw an error.
     */
    mergeChangeWithPriority(change: Change) {
        const firstChange = this.change(change.entityId);

        if (!firstChange) {
            this.addChange(change);
            return;
        }

        const firstCT = firstChange.type();
        const nextCT = change.type();
        // Empty changes have no effect on composition.
        if (nextCT === ChangeType.EMPTY) {
            return;
        }
        if (firstCT === ChangeType.EMPTY) {
            this._data[change.entityId] = change.data;
            return;
        }

        if (firstCT === ChangeType.UPDATE && nextCT === ChangeType.UPDATE) {
            /*
             * 1) UPDATE > UPDATE
             *    Keep the earliest before-state and the final after-state.
             *    Fields restored to their original state cancel.
             */
            const firstKeys = new Set([
                ...Object.keys(firstChange.reverseComponent),
                ...Object.keys(firstChange.forwardComponent),
            ]);
            const reverse: Record<string, any> = { ...firstChange.reverseComponent };
            // A previously affected field must keep its original before-state,
            // even if that state was absence (no reverse entry).
            for (const [key, value] of Object.entries(change.reverseComponent)) {
                if (!firstKeys.has(key)) {
                    reverse[key] = value;
                }
            }
            firstChange.reverseComponent = reverse;
            firstChange.forwardComponent = applyComponents(
                firstChange.forwardComponent, change.reverseComponent, change.forwardComponent,
            );
            if (changeReducesToNone(firstChange)) {
                this.removeChange(change.entityId);
            }

        } else if (firstCT === ChangeType.CREATE && nextCT === ChangeType.UPDATE) {
            /*
             * 2) CREATE > UPDATE
             *    Create the entity in its final state, including field removals.
             */
            firstChange.forwardComponent = applyComponents(
                firstChange.forwardComponent, change.reverseComponent, change.forwardComponent,
            );

        } else if (firstCT === ChangeType.DELETE && nextCT === ChangeType.CREATE) {
            /*
             * 3) DELETE > CREATE
             *    The entity exists at both endpoints. This is an update from
             *    the pre-delete data to the new data, or no change if identical.
             */
            this._data[change.entityId] = [
                change.entityId, firstChange.reverseComponent, change.forwardComponent,
            ];
            const mergedChange = this.change(change.entityId)!;
            if (changeReducesToNone(mergedChange)) {
                this.removeChange(change.entityId);
            }

        } else if (firstCT === ChangeType.CREATE && nextCT === ChangeType.DELETE) {
            /*
             * 4) CREATE > DELETE
             *    The entity is absent at both endpoints, so there is no net change.
             */
            this.removeChange(change.entityId);

        } else if (firstCT === ChangeType.UPDATE && nextCT === ChangeType.DELETE) {
            /*
             * 5) UPDATE > DELETE
             *    Delete with the original state in reverse, not the state at
             *    deletion time. Undo restores removed fields and leaves fields
             *    added by the update absent.
             */
            const originalState = applyComponents(
                change.reverseComponent, firstChange.forwardComponent, firstChange.reverseComponent,
            );
            this._data[change.entityId] = [
                change.entityId, originalState, {},
            ];

        } else {
            throw new Error(
                `Cannot compose ${ChangeType[firstCT]} then ${ChangeType[nextCT]} for ${change.entityId}`,
            );
        }
    }

    changeType(entityId: string, reverse: boolean = false): ChangeType {
        let change = this.change(entityId);
        if (!change) {
            throw Error('No entity delta for the given entityId');
        }
        if (reverse) {
            change = change.reversed();
        }
        return change.type();
    }

    /**
     * Compose another delta after this one, in place, at the entity-field level.
     * Keep the earliest before-state and final after-state of affected fields,
     * including field absence. The result has the same effect as both in order.
     */
    mergeWithPriority(next: Delta) {
        for (const change of next.changes()) {
            this.mergeChangeWithPriority(change);
        }
    }
}

/** Compose wire-format deltas in order into one net change. */
export function squashDeltas(deltas: DeltaData[]) {
    const squashedDelta = new Delta({});

    for (let delta of deltas) {
        squashedDelta.mergeWithPriority(new Delta(structuredClone(delta)));
    }

    return squashedDelta;
}
