import { Delta, DeltaData, squashDeltas } from "./Delta";
import { Change, ChangeType } from "./Change";
import { DummyPage } from "../storage/test-utils";

const entityData = { id: "e", parent_id: "", type_name: "DummyPage" };

describe("Change classification", () => {
    const cases: [string, Record<string, unknown>, Record<string, unknown>, ChangeType][] = [
        ["empty", {}, {}, ChangeType.EMPTY],
        ["create complete entity data", {}, { id: "e", parent_id: "", type_name: "DummyPage", name: "page" }, ChangeType.CREATE],
        ["delete complete entity data", { id: "e", parent_id: "", type_name: "DummyPage", name: "page" }, {}, ChangeType.DELETE],
        ["add field", {}, { name: "page" }, ChangeType.UPDATE],
        ["remove field", { name: "page" }, {}, ChangeType.UPDATE],
        ["absent to null", {}, { name: null }, ChangeType.UPDATE],
        ["null to absent", { name: null }, {}, ChangeType.UPDATE],
        ["create classification does not validate id", {}, { ...entityData, id: "other" }, ChangeType.CREATE],
        ["delete classification does not validate id", { ...entityData, id: "other" }, {}, ChangeType.DELETE],
    ];

    test.each(cases)("%s", (_, reverse, forward, expectedType) => {
        expect(new Change(["e", reverse, forward]).type()).toBe(expectedType);
    });

    test("reversal preserves presence and is involutive", () => {
        const data: DeltaData = {
            created: ["created", {}, { ...entityData, id: "created" }],
            deleted: ["deleted", { ...entityData, id: "deleted" }, {}],
            updated: ["updated", { removed: null, name: "old" }, { added: null, name: "new" }],
        };
        const delta = new Delta(data);
        expect(delta.reversed().data).toEqual({
            created: ["created", { ...entityData, id: "created" }, {}],
            deleted: ["deleted", {}, { ...entityData, id: "deleted" }],
            updated: ["updated", { added: null, name: "new" }, { removed: null, name: "old" }],
        });
        expect(delta.reversed().reversed().data).toEqual(data);
    });
});

describe("Delta.fromEntities", () => {
    test("creates copied snapshots from entity iterables", () => {
        expect(Delta.fromEntities([]).isEmpty()).toBe(true);
        const entity = new DummyPage({ id: "e", parent_id: "", name: "first" });
        const delta = Delta.fromEntities([entity].values());
        expect(delta.data).toEqual({
            e: ["e", {}, { id: "e", parent_id: "", name: "first", type_name: "DummyPage" }],
        });
        expect(delta.change("e")!.type()).toBe(ChangeType.CREATE);

        entity.name = "second";
        expect(delta.data.e[2].name).toBe("first");
        delta.data.e[2].name = "third";
        expect(entity.name).toBe("second");
    });

    test("reverse and compose compares snapshots without mutating them", () => {
        const shared = new DummyPage({ id: "e", parent_id: "", name: "first" });
        const updated = new DummyPage({ id: "e", parent_id: "", name: "second" });
        const unchanged = new DummyPage({ id: "unchanged", parent_id: "", name: "same" });
        const removed = new DummyPage({ id: "removed", parent_id: "", name: "removed" });
        const added = new DummyPage({ id: "added", parent_id: "", name: "added" });
        const from = [shared, unchanged, removed];
        const to = [updated, unchanged, added];
        const snapshots = [...from, ...to].map(entity => entity.data());

        const delta = Delta.fromEntities(from).reversed();
        delta.mergeWithPriority(Delta.fromEntities(to));

        expect(delta.data).toEqual({
            e: ["e", { name: "first" }, { name: "second" }],
            removed: ["removed", { ...removed.data(), type_name: "DummyPage" }, {}],
            added: ["added", {}, { ...added.data(), type_name: "DummyPage" }],
        });
        expect([...from, ...to].map(entity => entity.data())).toEqual(snapshots);
    });
});

describe("Delta mergeChangeWithPriority", () => {
    const mergeCases: [string, DeltaData, DeltaData, DeltaData][] = [
        [
            "same field cancels",
            { e: ["e", { x: 1 }, { x: 2 }] },
            { e: ["e", { x: 2 }, { x: 1 }] },
            {},
        ],
        [
            "different fields accumulate",
            { e: ["e", { x: 1 }, { x: 2 }] },
            { e: ["e", { y: 3 }, { y: 4 }] },
            { e: ["e", { x: 1, y: 3 }, { x: 2, y: 4 }] },
        ],
        [
            "same field keeps earliest reverse and latest forward",
            { e: ["e", { x: 1 }, { x: 2 }] },
            { e: ["e", { x: 2 }, { x: 3 }] },
            { e: ["e", { x: 1 }, { x: 3 }] },
        ],
        [
            "CREATE > UPDATE changes and removes fields",
            { e: ["e", {}, { ...entityData, home: "page-a", name: "first" }] },
            { e: ["e", { home: "page-a", name: "first" }, { name: "second" }] },
            { e: ["e", {}, { ...entityData, name: "second" }] },
        ],
        [
            "CREATE > DELETE cancels",
            { e: ["e", {}, { ...entityData }] },
            { e: ["e", { ...entityData }, {}] },
            {},
        ],
        [
            "DELETE > CREATE keeps only differing fields",
            { e: ["e", { ...entityData, x: 1, y: 2 }, {}] },
            { e: ["e", {}, { ...entityData, x: 3, y: 2 }] },
            { e: ["e", { x: 1 }, { x: 3 }] },
        ],
        [
            "DELETE > CREATE identical data cancels",
            { e: ["e", { ...entityData }, {}] },
            { e: ["e", {}, { ...entityData }] },
            {},
        ],
        [
            "UPDATE > DELETE restores original values and excludes added fields",
            { e: ["e", { name: "first" }, { name: "second", home: "page-a" }] },
            { e: ["e", { ...entityData, name: "second", home: "page-a", x: 10 }, {}] },
            { e: ["e", { ...entityData, name: "first", x: 10 }, {}] },
        ],
        [
            "changed field then removed",
            { e: ["e", { home: "page-a", name: "first" }, { home: "page-b", name: "second" }] },
            { e: ["e", { home: "page-b", name: "second" }, { name: "third" }] },
            { e: ["e", { home: "page-a", name: "first" }, { name: "third" }] },
        ],
        [
            "add > remove cancels absent endpoints",
            { e: ["e", {}, { home: "page-a" }] },
            { e: ["e", { home: "page-a" }, {}] },
            {},
        ],
        [
            "remove > re-add same value cancels",
            { e: ["e", { home: "page-a" }, {}] },
            { e: ["e", {}, { home: "page-a" }] },
            {},
        ],
        [
            "remove > re-add different value",
            { e: ["e", { home: "page-a" }, {}] },
            { e: ["e", {}, { home: "page-b" }] },
            { e: ["e", { home: "page-a" }, { home: "page-b" }] },
        ],
        [
            "add null > replace preserves initial absence",
            { e: ["e", {}, { home: null }] },
            { e: ["e", { home: null }, { home: "page-a" }] },
            { e: ["e", {}, { home: "page-a" }] },
        ],
        [
            "null > absent > value preserves original null",
            { e: ["e", { home: null }, {}] },
            { e: ["e", {}, { home: "page-a" }] },
            { e: ["e", { home: null }, { home: "page-a" }] },
        ],
        [
            "EMPTY > UPDATE is identity",
            { e: ["e", {}, {}] },
            { e: ["e", { x: 1 }, { x: 2 }] },
            { e: ["e", { x: 1 }, { x: 2 }] },
        ],
        [
            "UPDATE > EMPTY is identity",
            { e: ["e", { x: 1 }, { x: 2 }] },
            { e: ["e", {}, {}] },
            { e: ["e", { x: 1 }, { x: 2 }] },
        ],
    ];

    test.each(mergeCases)("%s", (_, first, next, expected) => {
        const delta = new Delta(first);
        delta.mergeWithPriority(new Delta(next));
        expect(delta.data).toEqual(expected);
    });

    test("invalid lifecycle composition raises", () => {
        const create: DeltaData = { e: ["e", {}, { ...entityData }] };
        expect(() => new Delta(create).mergeWithPriority(new Delta(create))).toThrow();
    });
});

describe("squashDeltas", () => {
    const squashCases: [string, DeltaData[], DeltaData][] = [
        [
            "CREATE > UPDATE > DELETE cancels",
            [
                { e: ["e", {}, { ...entityData, x: 1 }] },
                { e: ["e", { x: 1 }, { x: 2 }] },
                { e: ["e", { ...entityData, x: 2 }, {}] },
            ],
            {},
        ],
        [
            "multiple updates accumulate",
            [
                { e: ["e", { x: 1 }, { x: 2 }] },
                { e: ["e", { x: 2 }, { x: 3 }] },
                { e: ["e", { y: 0 }, { y: 5 }] },
            ],
            { e: ["e", { x: 1, y: 0 }, { x: 3, y: 5 }] },
        ],
        [
            "DELETE > CREATE > UPDATE",
            [
                { e: ["e", { ...entityData, x: 1, y: 2 }, {}] },
                { e: ["e", {}, { ...entityData, x: 10, y: 20 }] },
                { e: ["e", { x: 10 }, { x: 30 }] },
            ],
            { e: ["e", { x: 1, y: 2 }, { x: 30, y: 20 }] },
        ],
        [
            "independent entities do not interfere",
            [
                { a: ["a", {}, { ...entityData, id: "a", v: 1 }], b: ["b", { v: 0 }, { v: 1 }] },
                { a: ["a", { v: 1 }, { v: 2 }] },
                { b: ["b", { ...entityData, id: "b", v: 1 }, {}] },
            ],
            {
                a: ["a", {}, { ...entityData, id: "a", v: 2 }],
                b: ["b", { ...entityData, id: "b", v: 0 }, {}],
            },
        ],
        [
            "add > remove > re-add null",
            [
                { e: ["e", {}, { home: "page-a" }] },
                { e: ["e", { home: "page-a" }, {}] },
                { e: ["e", {}, { home: null }] },
            ],
            { e: ["e", {}, { home: null }] },
        ],
        [
            "replace > remove > re-add preserves original endpoint",
            [
                { e: ["e", { home: "page-a", x: 0 }, { home: "page-b", x: 1 }] },
                { e: ["e", { home: "page-b", x: 1 }, { x: 2 }] },
                { e: ["e", { x: 2 }, { home: "page-c", x: 3 }] },
            ],
            { e: ["e", { home: "page-a", x: 0 }, { home: "page-c", x: 3 }] },
        ],
    ];

    test.each(squashCases)("%s", (_, deltas, expected) => {
        expect(squashDeltas(deltas).data).toEqual(expected);
    });

    test("squashDeltas does not mutate input delta data", () => {
        const delta0: DeltaData = { e: ["e", {}, { ...entityData, x: 1, y: 2 }] };
        const delta1: DeltaData = { e: ["e", { x: 1 }, { x: 3 }] };
        const delta0Copy = JSON.parse(JSON.stringify(delta0));
        const delta1Copy = JSON.parse(JSON.stringify(delta1));

        squashDeltas([delta0, delta1]);

        // Input deltas must remain unchanged
        expect(delta0).toEqual(delta0Copy);
        expect(delta1).toEqual(delta1Copy);
    });
});
