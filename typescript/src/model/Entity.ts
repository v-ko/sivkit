import { Change, ChangeType } from "./Change";
import { getLogger } from "../logging";
import { createId } from "../util/base";

const log = getLogger('entity.ts');

// Library related variables and functions
let entityLibrary: { [key: string]: typeof Entity<any> } = {};
let _lastEntityId: number = 0


let _reproducibleIds = false;
export function setReproducibleIds(reproducible: boolean) {
    _reproducibleIds = reproducible;
}

export function getEntityId(): string {
    if (_reproducibleIds) {
        _lastEntityId += 1;
        return _lastEntityId.toString().padStart(8, '0');
    } else {
        return createId();
    }
}


export function resetEntityIdCounter() {
    _lastEntityId = 0
}

function copyThreeLevelsDown(obj: any, depth: number = 0): any {
    if (depth > 3 || obj === null || typeof obj !== 'object') {
        return obj;
    }
    if (Array.isArray(obj)) {
        return obj.map(item => copyThreeLevelsDown(item, depth + 1));
    }
    const newObj: Record<string, any> = {};
    for (const key in obj) {
        newObj[key] = copyThreeLevelsDown(obj[key], depth + 1);
    }
    return newObj;
}

export function entityType<T extends typeof Entity<S>, S extends EntityData>(name: string): any {
    /**
     * The decorator for regiestering entities
     */
    // If 'name' is not a string - throw error
    if (typeof name !== 'string') {
        throw new Error('Entity type name must be a string');
    }

    return function (entity_class: T): T {
        entityLibrary[name] = entity_class;
        (entity_class as any)._typeName = name;
        return entity_class;
    }
}

export function getEntityClassByName<T extends typeof Entity>(entity_class_name: string): T {
    return entityLibrary[entity_class_name] as T
}


export interface SerializedEntityData extends EntityData {
    type_name: string;
}

// Serialization related functions
export function dumpToDict<T extends Entity<EntityData>>(entity: T): SerializedEntityData {
    const entityDict = entity.data() as SerializedEntityData
    const typeName = (entity.constructor as any)._typeName as string | undefined
    if (!typeName || entityLibrary[typeName] === undefined) {
        throw new Error(`Entity class ${entity.constructor.name} not found in the library`);
    }
    entityDict.type_name = typeName
    return entityDict
}


export function loadFromDict<T extends SerializedEntityData>(entityDict: T): Entity<EntityData> {
    const { type_name, ...entityData } = entityDict
    const cls = getEntityClassByName(type_name)
    let instance: any

    if (cls === undefined) {
        throw new Error(`Entity class ${type_name} not found.`)
    } else {
        instance = new (cls as new (data: EntityData) => Entity<EntityData>)(entityData as EntityData)
    }
    return instance
}

// Entity definition
export interface EntityData {
    id: string;  // Allows for composite ids
    parent_id: string;  // Yes, we use snake_case for serialization
    _data?: never;  // Breaks the scructural compatability between Entity and EntityData which otherwise masks passing the wrong object type
}


export abstract class Entity<T extends EntityData> {
    // The 3 levels of data can be interpreted as:
    //  entit instance: 1. metadata scope , 2 metadata object , 3. property
    // like entity.content.image.width
    _data: T;

    constructor(data: T) {  // Optional parent_id, defaults to ''
        // if data has _ data field throw error
        if (data['_data']) {
            throw new Error('Entity data cannot have _ field');
        }
        data.parent_id = data.parent_id || '';
        this._data = data as T;
    }

    get id(): string {
        return this._data.id;
    }
    get parentId(): string {
        return this._data.parent_id;
    }

    copy(): this {
        // We're doing the deep copy in data(), so no need to do it here
        return new (<any>this.constructor)(this.data());
    }
    data(): T {
        // Copy only three levels down, to avoid copy overhead on bad model design
        return copyThreeLevelsDown(this._data);
    }

    replace(new_data: Omit<Partial<T>, 'id'>): void {
        // if (new_data.id !== undefined) {
        //     throw new Error(
        //         'The id of an entity is immutable. Use the withId method to create an object with the new id.');
        // }
        const newData = { ...this._data, ...new_data };
        this._data = newData;
    }

    changeFrom(other: Entity<EntityData>): Change {
        /**
         * Granularity: level 1 entity property. Read below!
         * If a level1 key object (or its children) has changed
         * (like entity.content.image.width) - the whole key is added to the delta
         */
        if (this.id !== other.id) {
            throw new Error('Cannot create delta from different entities');
        }
        const oldState: Record<string, any> = dumpToDict(this);
        const newState: Record<string, any> = dumpToDict(other);

        const reverseDelta: Record<string, any> = {};
        const forwardDelta: Record<string, any> = {};

        const allKeys = new Set([...Object.keys(oldState), ...Object.keys(newState)]);
        for (const key of allKeys) {
            const oldVal = oldState[key];
            const newVal = newState[key];

            if (!entityKeysAreEqual(oldVal, newVal)) {
                if (oldVal !== undefined) {
                    reverseDelta[key] = oldVal;
                }
                if (newVal !== undefined) {
                    forwardDelta[key] = newVal;
                }
            }
        }

        return new Change([this.id, reverseDelta, forwardDelta])
    }

}

// Helper function to check deep equality of entity properties up to 3 levels
// like entity.content.image.width (that's the max depth)
export function entityKeysAreEqual(value1: any, value2: any, depth = 1): boolean {
    if (depth > 3) {
        throw new Error("Depth exceeded: This function supports comparison up to 3 levels deep only.");
    }

    if (typeof value1 !== typeof value2) return false;

    // Handling nulls and non-objects
    if (value1 === null || value2 === null) return value1 === value2;
    if (typeof value1 !== 'object' || typeof value2 !== 'object') return value1 === value2;

    // Check if both are arrays
    if (Array.isArray(value1) && Array.isArray(value2)) {
        if (value1.length !== value2.length) return false;
        for (let i = 0; i < value1.length; i++) {
            if (!entityKeysAreEqual(value1[i], value2[i], depth + 1)) return false;
        }
        return true;
    }

    // Ensure both values are of type object and not one of them is an array
    if (Array.isArray(value1) || Array.isArray(value2)) return false;

    // Compare properties if both are objects
    const keys1 = Object.keys(value1);
    const keys2 = Object.keys(value2);
    if (keys1.length !== keys2.length) return false;

    for (const key of keys1) {
        const val1 = value1[key];
        const val2 = value2[key];
        if (typeof val1 === 'object' && val1 !== null && val2 !== null) {
            if (!entityKeysAreEqual(val1, val2, depth + 1)) return false;
        } else if (val1 !== val2) {
            return false;
        }
    }

    return true;
}

export function transformedEntity(entity: Entity<EntityData>, change: Change){
    if (entity.id !== change.entityId) {
        throw new Error('Cannot apply delta from different entities');
    }

    if (change.type() !== ChangeType.UPDATE) {
        throw new Error('Cannot apply delta that is not an update');
    }

    const forwardDelta = change.forwardComponent;
    let newData = { ...dumpToDict(entity), ...forwardDelta };
    return loadFromDict(newData);
}
