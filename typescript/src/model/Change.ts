import { Entity, EntityData, SerializedEntityData, dumpToDict } from "./Entity"

export type ChangeComponent = Partial<SerializedEntityData>;

export enum ChangeType {
    EMPTY = 0,
    CREATE = 1,
    UPDATE = 2,
    DELETE = 3
}

export type ChangeData = [
    string, // entity id
    Record<string, any>, // reverse change component
    Record<string, any> // forward change component (apply to get new state)
];

export class Change {
    private _data: ChangeData

    constructor(data: ChangeData) {
        this._data = data
    }

    get data(): ChangeData {
        return this._data
    }

    get entityId(): string {
        return this._data[0]
    }

    get reverseComponent(): ChangeComponent {
        return this._data[1]
    }
    set reverseComponent(value: ChangeComponent) {
        this._data[1] = value
    }

    get forwardComponent(): ChangeComponent {
        return this._data[2]
    }
    set forwardComponent(value: ChangeComponent) {
        this._data[2] = value
    }

    type() {
        const hasReverse = Object.keys(this.reverseComponent).length > 0
        const hasForward = Object.keys(this.forwardComponent).length > 0
        if (hasReverse && hasForward) {
            return ChangeType.UPDATE
        } else if (hasReverse) {
            return ChangeType.DELETE
        } else if (hasForward) {
            return ChangeType.CREATE
        } else {
            return ChangeType.EMPTY
        }
    }

    static create(entity: Entity<EntityData>): Change {
        return new Change([entity.id, {}, dumpToDict(entity)])
    }

    static delete(entity: Entity<EntityData>): Change {
        return new Change([entity.id, dumpToDict(entity), {}])
    }

    static update(oldState: Entity<EntityData>, newState: Entity<EntityData>): Change {
        return oldState.changeFrom(newState)
    }

    reversed(): Change {
        return new Change([this.entityId, this.forwardComponent, this.reverseComponent])
    }

    isCreate(): boolean {
        return this.type() === ChangeType.CREATE
    }

    isDelete(): boolean {
        return this.type() === ChangeType.DELETE
    }

    isUpdate(): boolean {
        return this.type() === ChangeType.UPDATE
    }

    isEmpty(): boolean {
        return this.type() === ChangeType.EMPTY
    }
}
