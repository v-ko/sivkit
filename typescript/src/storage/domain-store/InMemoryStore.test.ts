import { Delta } from "../../model/Delta";
import { InMemoryStore } from "./InMemoryStore";
import { indexConfigs, DummyPage, DummyNote } from "sivkit/storage/test-utils";

describe("InMemoryStore", () => {
    let store = new InMemoryStore(indexConfigs);

    beforeEach(() => {
        store = new InMemoryStore(indexConfigs);
    });

    test("Entity CRUD operations", () => {
        let entity = new DummyPage({
            id: "123",
            parent_id: '',
            name: "Test Page",
        })

        // Test insert
        let changeCreate = store.insertOne(entity);
        expect(changeCreate).toBeDefined();

        let all_entities = [...store.find()];
        expect(all_entities.length).toBe(1);

        // Test update
        entity.name = "456";
        let changeUpdate = store.updateOne(entity);
        expect(changeUpdate).toBeDefined();
        expect([...store.find()].length).toBe(1);

        // Test delete
        let changeDelete = store.removeOne(entity);
        expect(changeDelete).toBeDefined();
        expect([...store.find()].length).toBe(0);
    });

    // Test find by id, parent-id, type and prop
    // Add a page and a note to the store and test the find method
    test("Find by id, parent-id, type and prop", () => {
        let page = new DummyPage({
            id: "123",
            parent_id: '',
            name: "Test Page",
        })
        let note = new DummyNote({
            id: "456",
            testProp: "Test Note",
            parent_id: "123"
        });

        store.insertOne(page);
        store.insertOne(note);

        // Test find by id
        let foundPage = store.findOne({ id: "123" });
        expect(foundPage).toEqual(page);

        // Test find by parent-id
        let foundNote = store.findOne({ parentId: "123" });
        expect(foundNote).toEqual(note);

        // Test find by type
        let foundPage2 = store.findOne({ type: DummyPage });
        expect(foundPage2).toEqual(page);

        let foundNote2 = store.findOne({ type: DummyNote });
        expect(foundNote2).toEqual(note);

        // Test find by prop
        let foundNote3 = store.findOne({ testProp: "Test Note" });
        expect(foundNote3).toEqual(note);
    });

    // Test delta operations
    // Add a page, add a couple of notes, update the second note, remove the
    // first note. Then infer the delta from the changes, reverse it and
    // infer that the repo is empty
    test("Delta operations", () => {
        let page = new DummyPage({
            id: "123",
            parent_id: '',
            name: "Test Page",
        })
        let note1 = new DummyNote({
            id: "456",
            testProp: "Test Note 1",
            parent_id: "123"
        });
        let note2 = new DummyNote({
            id: "789",
            testProp: "Test Note 2",
            parent_id: "123"
        });

        let changes = [
            store.insertOne(page),
            store.insertOne(note1),
            store.insertOne(note2),
        ]

        note2._data.testProp = "Updated Note 2";

        // Check that the repo has copied the entity (so that alterations cannot
        // leak over the repo interface)
        let repoNote2 = store.findOne({ id: "789" });
        expect((repoNote2 as DummyNote)._data.testProp).toBe("Test Note 2");

        let delta = Delta.fromChanges(changes);

        let changeDelete = store.removeOne(note1);
        changes.push(changeDelete);

        delta = Delta.fromChanges(changes);

        let changeUpdate = store.updateOne(note2);
        changes.push(changeUpdate);

        delta = Delta.fromChanges(changes);
        delta = delta.reversed()

        let reverseChanges = delta.changes();
        for (let change of reverseChanges) {
            store.applyChange(change);
        }

        let all_entities = [...store.find()];
        expect(all_entities.length).toBe(0);
    });

    test("Store copies on insert and update — external mutation is isolated", () => {
        let page = new DummyPage({ id: "copy-test", parent_id: '', name: "Original" });
        store.insertOne(page);

        // Mutating original doesn't affect store
        page._data.name = "Mutated";
        let stored = store.findOne({ id: "copy-test" }) as DummyPage;
        expect(stored._data.name).toBe("Original");
        expect(stored).not.toBe(page);

        // updateOne detects the diff and fires the callbacks
        const deltas: Delta[] = [];
        store.addOnChangesCallback((d: Delta) => deltas.push(d));
        let change = store.updateOne(page);
        expect(change.isEmpty()).toBe(false);
        expect(deltas.length).toBe(1);
        expect((store.findOne({ id: "copy-test" }) as DummyPage)._data.name).toBe("Mutated");
    });
});
