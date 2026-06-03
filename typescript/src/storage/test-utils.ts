import { EntityData, entityType, Entity } from "sivkit/model/Entity";
import { IndexConfig, ENTITY_TYPE_INDEX_KEY } from "sivkit/storage/domain-store/InMemoryStore";


export const indexConfigs: readonly IndexConfig[] = [
    {
        fields: [{ indexKey: "id" }],
        isUnique: true,
        name: "id"
    },
    {
        fields: [{ indexKey: "id" }],
        isUnique: false,
        name: "parentId"
    },
    {
        fields: [{
            indexKey: ENTITY_TYPE_INDEX_KEY,
            allowedTypes: ['DummyPage', 'DummyNote']
        }],
        isUnique: false,
        name: 'by_class_name'
    }
];
interface DummyPageData extends EntityData {
    name: string;
}
// mock Page entity subclass

@entityType("DummyPage")
export class DummyPage extends Entity<DummyPageData> {
    constructor(data: DummyPageData) {
        super(data);
    }
    get name(): string {
        return this._data.name;
    }
    set name(name: string) {
        this._data.name = name;
    }
}
interface DummyNoteData extends EntityData {
    testProp: string;
}

@entityType("DummyNote")
export class DummyNote extends Entity<DummyNoteData> {
    constructor(data: DummyNoteData) {
        super(data);
    }
    get parentId(): string {
        return this._data.parent_id;
    }
    // get testProp(): string {
    //     return this._data.name;
    // }
    // set testProp(name: string) {
    //     this._data.name = name;
    // }
    get testProp(): string {
        return this._data.testProp;
    }
    set testProp(newVal: string) {
        this._data.testProp = newVal;
    }
}
