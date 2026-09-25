import { InMemoryStore } from "../domain-store/InMemoryStore";
import { indexConfigs, DummyPage } from "sivkit/storage/test-utils";
import { Delta } from "../../model/Delta";
import { Change } from "../../model/Change";
import { ActionState, registerRootActionChangesHandler } from "../../registries/Action";
import { StoreSyncServiceBase } from "./StoreSyncServiceBase";

class TestSyncService extends StoreSyncServiceBase {
    async initialize() {}
    async pushDelta(_delta: Delta) {}
    dispose() {}
    receive(delta: Delta) { this.applyRemoteDelta(delta); }
}

const createDelta = (id: string) =>
    Delta.fromChanges([Change.create(new DummyPage({ id, parent_id: '', name: id }))]);

describe("StoreSyncServiceBase.applyRemoteDelta", () => {
    test("applies in a service action only when the store requires one", () => {
        const store = new InMemoryStore(indexConfigs);
        const service = new TestSyncService();
        service.setStore(store);
        service.receive(createDelta('a'));
        expect(store.findOne({ id: 'a' })).toBeDefined();

        const roots: ActionState[] = [];
        const unregister = registerRootActionChangesHandler(store, (root) => roots.push(root));
        try {
            service.receive(createDelta('b'));
        } finally {
            unregister();
        }
        expect(store.findOne({ id: 'b' })).toBeDefined();
        expect(roots.map(r => r.name)).toEqual(['[service]applyRemoteDelta']);
    });
});
