import { Delta, DeltaData, squashDeltas } from "./Delta";
import { ChangeType } from "./Change";

describe("Delta mergeChangeWithPriority", () => {
    // [description, firstDelta, nextDelta, expectedType|null, expectedReverse, expectedForward]
    const mergeCases: [string, any, any, ChangeType | null, any, any][] = [
        [
            "UPDATE > UPDATE (same field cancels)",
            { e: ["e", { x: 1 }, { x: 2 }] },
            { e: ["e", { x: 2 }, { x: 1 }] },
            null, null, null,
        ],
        [
            "UPDATE > UPDATE (different fields accumulate)",
            { e: ["e", { x: 1 }, { x: 2 }] },
            { e: ["e", { y: 3 }, { y: 4 }] },
            ChangeType.UPDATE,
            { y: 3, x: 1 },
            { y: 4, x: 2 },
        ],
        [
            "UPDATE > UPDATE (same field, second wins forward)",
            { e: ["e", { x: 1 }, { x: 2 }] },
            { e: ["e", { x: 2 }, { x: 3 }] },
            ChangeType.UPDATE,
            { x: 1 },
            { x: 3 },
        ],
        [
            "CREATE > UPDATE (extends create forward)",
            { e: ["e", {}, { x: 1 }] },
            { e: ["e", { x: 1 }, { x: 2 }] },
            ChangeType.CREATE,
            {},
            { x: 2 },
        ],
        [
            "CREATE > DELETE (net nothing)",
            { e: ["e", {}, { x: 1, y: 2 }] },
            { e: ["e", { x: 1, y: 2 }, {}] },
            null, null, null,
        ],
        [
            "DELETE > CREATE (becomes update, unchanged fields stripped)",
            { e: ["e", { x: 1, y: 2 }, {}] },
            { e: ["e", {}, { x: 3, y: 2 }] },
            ChangeType.UPDATE,
            { x: 1 },
            { x: 3 },
        ],
        [
            "DELETE > CREATE same data (cancels to nothing)",
            { e: ["e", { x: 1 }, {}] },
            { e: ["e", {}, { x: 1 }] },
            null, null, null,
        ],
        [
            "UPDATE > DELETE (net = delete with original state)",
            { e: ["e", { color: "red" }, { color: "blue" }] },
            { e: ["e", { color: "blue", x: 10 }, {}] },
            ChangeType.DELETE,
            { color: "red", x: 10 },
            {},
        ],
    ];

    test.each(mergeCases)("%s", (_, first, next, expectedType, expectedReverse, expectedForward) => {
        const delta = new Delta(first);
        delta.mergeWithPriority(new Delta(next));
        const change = delta.change("e");
        if (expectedType === null) {
            expect(change).toBeUndefined();
        } else {
            expect(change).toBeDefined();
            expect(change!.type()).toBe(expectedType);
            expect(change!.reverseComponent).toEqual(expectedReverse);
            expect(change!.forwardComponent).toEqual(expectedForward);
        }
    });
});

describe("squashDeltas", () => {
    // [description, array of deltas, entityId, expectedType|null, expectedReverse, expectedForward]
    const squashCases: [string, any[], string, ChangeType | null, any, any][] = [
        [
            "CREATE > UPDATE > DELETE = nothing",
            [
                { e: ["e", {}, { x: 1 }] },
                { e: ["e", { x: 1 }, { x: 2 }] },
                { e: ["e", { x: 2 }, {}] },
            ],
            "e", null, null, null,
        ],
        [
            "multiple UPDATEs accumulate",
            [
                { e: ["e", { x: 1 }, { x: 2 }] },
                { e: ["e", { x: 2 }, { x: 3 }] },
                { e: ["e", { y: 0 }, { y: 5 }] },
            ],
            "e", ChangeType.UPDATE, { x: 1, y: 0 }, { x: 3, y: 5 },
        ],
        [
            "UPDATE > DELETE (pre-existing entity)",
            [
                { e: ["e", { x: 5 }, { x: 10 }] },
                { e: ["e", { x: 10, name: "foo" }, {}] },
            ],
            "e", ChangeType.DELETE, { x: 5, name: "foo" }, {},
        ],
        [
            "DELETE > CREATE > UPDATE (re-creation cycle)",
            [
                { e: ["e", { x: 1, y: 2 }, {}] },
                { e: ["e", {}, { x: 10, y: 20 }] },
                { e: ["e", { x: 10 }, { x: 30 }] },
            ],
            "e", ChangeType.UPDATE, { x: 1, y: 2 }, { x: 30, y: 20 },
        ],
        [
            "independent entities don't interfere (entity a)",
            [
                { a: ["a", {}, { v: 1 }], b: ["b", { v: 0 }, { v: 1 }] },
                { a: ["a", { v: 1 }, { v: 2 }] },
                { b: ["b", { v: 1 }, {}] },
            ],
            "a", ChangeType.CREATE, {}, { v: 2 },
        ],
        [
            "independent entities don't interfere (entity b)",
            [
                { a: ["a", {}, { v: 1 }], b: ["b", { v: 0 }, { v: 1 }] },
                { a: ["a", { v: 1 }, { v: 2 }] },
                { b: ["b", { v: 1 }, {}] },
            ],
            "b", ChangeType.DELETE, { v: 0 }, {},
        ],
    ];

    test.each(squashCases)("%s", (_, deltas, entityId, expectedType, expectedReverse, expectedForward) => {
        const squashed = squashDeltas(deltas);
        const change = squashed.change(entityId);
        if (expectedType === null) {
            expect(change).toBeUndefined();
        } else {
            expect(change).toBeDefined();
            expect(change!.type()).toBe(expectedType);
            expect(change!.reverseComponent).toEqual(expectedReverse);
            expect(change!.forwardComponent).toEqual(expectedForward);
        }
    });

    test("squashDeltas does not mutate input delta data", () => {
        const delta0: DeltaData = { e: ["e", {}, { x: 1, y: 2 }] };
        const delta1: DeltaData = { e: ["e", { x: 1 }, { x: 3 }] };
        const delta0Copy = JSON.parse(JSON.stringify(delta0));
        const delta1Copy = JSON.parse(JSON.stringify(delta1));

        squashDeltas([delta0, delta1]);

        // Input deltas must remain unchanged
        expect(delta0).toEqual(delta0Copy);
        expect(delta1).toEqual(delta1Copy);
    });
});
