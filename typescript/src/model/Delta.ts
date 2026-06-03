import { Change, ChangeData, ChangeType } from "./Change";
import { entityKeysAreEqual } from "./Entity";
import { getLogger } from "../logging";

let log = getLogger('Delta')

function changeReducesToNone(change: Change): boolean {
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

export class Delta {
    // Max entity key depth: e.g. entity.content.image.height - 3 levels
    // 1 property scope, 2 property object, 3 key
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

    reversed(): Delta {
        // Makes the changes in place
        const reversedData: DeltaData = {};
        for (const [entityId, reverseComponent, forwardComponent] of Object.values(this._data)) {
            reversedData[entityId] = [entityId, forwardComponent, reverseComponent];
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
    mergeChangeWithPriority(change: Change) {
        /**
         * Merges a new change (second/next) into the existing delta (first)
         * for a specific entity, as if it was applied afterward.
         *
         * This function enforces a priority or ordering, meaning
         * "the second/next change overrides or merges into the first."
         *
         * Supported patterns for merging:
         *  1) Update > Update   : Combine forward/reverse fields
         *  2) Create > Update   : Extend the 'create' forward component
         *  3) Delete > Create   : Treat as an 'update' (old data => new data)
         *  4) Create > Delete   : The creation is effectively canceled
         *  5) Otherwise         : Log as an error or do nothing
         *
         * Notes:
         *  - 'forwardComponent' describes how to go from the "old" to "new" state.
         *  - 'reverseComponent' describes how to go back from the "new" to "old" state.
         */
        const firstChange = this.change(change.entityId);

        // If no existing (first) change for this entity, just add the new one
        if (!firstChange) {
            this.addChange(change);
            return;
        }

        // Identify what kind of changes we're merging:
        const firstCT = firstChange.type();  // e.g. CREATE, UPDATE, DELETE
        const nextCT = change.type();        // the new change being merged in

        /**
         * 1) UPDATE > UPDATE
         *    We combine the forward components to reflect the sum of both updates,
         *    and merge reverse components to preserve the ability to revert back
         *    to the earliest "old" state if necessary.
         */
        if (firstCT === ChangeType.UPDATE && nextCT === ChangeType.UPDATE) {
            const firstForward = { ...firstChange.forwardComponent };
            const firstReverse = { ...firstChange.reverseComponent };
            const nextForward = change.forwardComponent;
            const nextReverse = change.reverseComponent;

            // Forward props: new update fields appended on top
            if (nextForward) {
                firstChange.forwardComponent = { ...firstForward, ...nextForward };
            }
            // Reverse props: nextReverse overrides firstReverse to revert properly
            if (nextReverse) {
                firstChange.reverseComponent = { ...nextReverse, ...firstReverse };
            }
            if (changeReducesToNone(firstChange)) {
                this.removeChange(change.entityId);
            }

        /**
         * 2) CREATE > UPDATE
         *    We interpret the second update as simply extending the forward part
         *    of the original CREATE. Because the entity was just created, we can
         *    "stack" these updates into its forward component.
         */
        } else if (firstCT === ChangeType.CREATE && nextCT === ChangeType.UPDATE) {
            if (change.forwardComponent) {
                firstChange.forwardComponent = {
                    ...firstChange.forwardComponent,
                    ...change.forwardComponent
                };
            }

        /**
         * 3) DELETE > CREATE
         *    The "delete" said "this entity used to exist, now it doesn't."
         *    The "create" says "here's a new version of the entity."
         *    Interpreting them together means we effectively have an 'update' from
         *    the old data to the newly created data (old => new).
         */
        } else if (firstCT === ChangeType.DELETE && nextCT === ChangeType.CREATE) {
            const oldData = firstChange.reverseComponent;  // Pre-delete data
            const newData = change.forwardComponent;       // Newly created data
            this._data[change.entityId] = [
                change.entityId,
                oldData,    // reverse => revert to "deleted" or old state
                newData     // forward => adopt the new data
            ];
            const mergedChange = this.change(change.entityId)!;
            if (changeReducesToNone(mergedChange)) {
                this.removeChange(change.entityId);
            }

        /**
         * 4) CREATE > DELETE
         *    Means we created an entity and are now deleting it before any usage.
         *    Net effect = remove both changes; there's no entity at all.
         */
        } else if (firstCT === ChangeType.CREATE && nextCT === ChangeType.DELETE) {
            this.removeChange(change.entityId);

        /**
         * 5) UPDATE > DELETE
         *    Entity was updated, then deleted. Net effect = DELETE with
         *    the reverse being the original state (before the update).
         *    The DELETE's reverse has the full state at deletion time (S1).
         *    We overlay the UPDATE's reverse fields to recover the pre-update state (S0).
         */
        } else if (firstCT === ChangeType.UPDATE && nextCT === ChangeType.DELETE) {
            const stateAtDeletion = change.reverseComponent;       // S1 (full)
            const updatedFieldsOldValues = firstChange.reverseComponent; // partial S0 fields
            const originalState = { ...stateAtDeletion, ...updatedFieldsOldValues };
            this._data[change.entityId] = [
                change.entityId,
                originalState,   // reverse => full state before any changes (S0)
                {}               // forward => empty (entity is gone)
            ];

        /**
         * 6) EMPTY or unhandled
         *    If the new change is empty, do nothing; if it's an irrational
         *    sequence (like 'Update > Create' on an entity that didn't exist),
         *    log an error.
         */
        } else if (nextCT === ChangeType.EMPTY) {
            // Nothing to do for empty changes
        } else {
            log.error(
                '[mergeWithPriority] Irrational or unhandled delta sequence. Merging change:\n',
                change,
                ' INTO:\n',
                firstChange
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

    mergeWithPriority(next: Delta) { // In place
        /**
         * Union with another delta up to the level of entity.key. I.e. if
         * there's an update for an entity - if the updated key in both deltas
         * is the same - the second one ('other') will override the key in
         * the forward operation. And the first one (this) will override in
         * the backward direction
         */
        // Iterate over all entity deltas in the next delta
        for (const change of next.changes()) {
            this.mergeChangeWithPriority(change);
        }
    }
}

export function squashDeltas(deltas: DeltaData[]) {
    const squashedDelta = new Delta({});

    for (let delta of deltas) {
        squashedDelta.mergeWithPriority(new Delta(structuredClone(delta)));
    }

    return squashedDelta;
}

function changeTypeFromData(
    entityDelta: ChangeData,
    reverse: boolean = false
): ChangeType {
    const [_, reverseDelta, forwardDelta] = entityDelta;
    const [componentToCheck, otherComponent] = reverse ? [forwardDelta, reverseDelta] : [reverseDelta, forwardDelta];

    const forwardPresent = Object.keys(otherComponent).length > 0;
    const reversePresent = Object.keys(componentToCheck).length > 0;

    if (forwardPresent && reversePresent) {
        return ChangeType.UPDATE;
    } else if (forwardPresent) {
        return ChangeType.CREATE;
    } else if (reversePresent) {
        return ChangeType.DELETE;
    } else {
        return ChangeType.EMPTY;
    }
}
