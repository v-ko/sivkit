import { InMemoryStore } from "../storage/domain-store/InMemoryStore";
import { indexConfigs, DummyPage } from "sivkit/storage/test-utils";
import { Delta } from "../model/Delta";
import { action } from "./Action";
import { isInProjection, registerProjection } from "./Projection";

describe("registerProjection", () => {
    let unregister: (() => void) | undefined;
    afterEach(() => unregister?.());

    test("projects each root action's merged changes, one projection per store", () => {
        const store = new InMemoryStore(indexConfigs);
        const page = (id: string) => new DummyPage({ id, parent_id: '', name: id });
        const projected: Delta[] = [];
        unregister = registerProjection(store, (delta, projectedStore) => {
            expect(isInProjection()).toBe(true);
            expect(projectedStore).toBe(store);
            projected.push(delta);
        });
        expect(() => registerProjection(store, () => {})).toThrow(/already registered/);

        class Actions {
            @action
            insertTwo() {
                store.insertOne(page('a'));
                store.insertOne(page('b'));
            }

            @action
            noop() {}
        }
        new Actions().insertTwo();
        new Actions().noop();
        expect(projected.length).toBe(2);
        expect(projected[0].entityIds().sort()).toEqual(['a', 'b']);
        expect(projected[1].isEmpty()).toBe(true);

        unregister();
        unregister = registerProjection(store, () => {});
    });
});
