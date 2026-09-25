import { InMemoryStore } from "../storage/domain-store/InMemoryStore";
import { indexConfigs, DummyPage } from "sivkit/storage/test-utils";
import { Delta } from "../model/Delta";
import { Change } from "../model/Change";
import { action, ActionRunStates, ActionState, DomainStoreChange, registerRootActionChangesHandler } from "./Action";

type Call = { root: ActionState; changes: DomainStoreChange[] };

describe("registerRootActionChangesHandler", () => {
    let store: InMemoryStore;
    let calls: Call[];
    let unregister: () => void;

    beforeEach(() => {
        store = new InMemoryStore(indexConfigs);
        calls = [];
        unregister = registerRootActionChangesHandler(store, (root, changes) => calls.push({ root, changes }));
    });

    afterEach(() => unregister());

    const page = (id: string) => new DummyPage({ id, parent_id: '', name: id });

    test("records each root action's changes and enforces actions while registered", () => {
        const other: DomainStoreChange[][] = [];
        const unregisterOther = registerRootActionChangesHandler(store, (_r, changes) => other.push(changes));
        const fired: Delta[] = [];
        store.addOnChangesCallback(d => fired.push(d));

        // Outside an action: throws before altering the store; loadData is exempt
        expect(() => store.insertOne(page('x'))).toThrow(/@action/);
        expect(() => store.applyDelta(Delta.fromChanges([Change.create(page('x'))]))).toThrow(/@action/);
        expect(store.findOne({ id: 'x' })).toBeUndefined();
        expect(fired).toEqual([]);
        store.loadData([page('l')]);

        class Actions {
            @action({ issuer: 'service' })
            inner() { store.insertOne(page('a')); }

            @action
            outer() {
                this.inner();
                store.applyDelta(Delta.fromChanges([Change.create(page('b'))]), 'remote');
            }

            @action
            noop() {}
        }
        new Actions().outer();
        new Actions().noop();

        const { root, changes } = calls[0];
        expect(root.name).toBe('[user]outer');
        expect(changes.map(c => [c.action.name, c.origin])).toEqual([
            ['[service]inner', undefined],
            ['[user]outer', 'remote'],
        ]);
        expect(changes[1].delta.change('b')).toBeDefined();
        expect(calls[1].changes).toEqual([]);
        expect(other.length).toBe(2);

        unregisterOther();
        expect(store.requireAction).toBe(true);
        unregister();
        expect(store.requireAction).toBe(false);
        new Actions().noop();
        store.insertOne(page('z'));
        expect(calls.length).toBe(2);
    });

    test("a throwing callback rolls back, surfaces, and earlier callbacks see the revert", () => {
        store.addOnChangesCallback(() => { throw new Error('listener failed'); });
        class Actions {
            @action
            insert() { store.insertOne(page('y')); }
        }
        expect(() => new Actions().insert()).toThrow('listener failed');
        expect(store.findOne({ id: 'y' })).toBeUndefined();
        const merged = new Delta({});
        for (const c of calls[0].changes) merged.mergeWithPriority(c.delta.copy());
        expect(merged.change('y')).toBeUndefined();
        expect(calls[0].root.runState).toBe(ActionRunStates.FAILED);
    });
});
