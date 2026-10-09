/**
 * Hash parity test — TypeScript side.
 *
 * Replays fixture deltas and compares incremental hashes with full rebuilds.
 * expected_states checks exact entity data at each step; check_composition
 * checks composed replay and both composed and sequential undo.
 *
 * Each fixture file is a JSON array of test cases.
 *
 * Usage:
 *     npx tsx test-parity-ts.ts [fixture.json]
 *
 * Defaults to fixtures/fuzz-42.json if no argument given.
 */

import { deepStrictEqual, strictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Entity, EntityData, SerializedEntityData, dumpToDict, entityType, loadFromDict } from "../../typescript/src/model/Entity";
import { Delta, DeltaData, squashDeltas } from "../../typescript/src/model/Delta";
import { InMemoryStore } from "../../typescript/src/storage/domain-store/InMemoryStore";
import { buildHashTree, updateHashTree } from "../../typescript/src/storage/version-control/HashTree";

// ── Test entity types (matching the fixture schema) ──

interface TestPageData extends EntityData {
    name: string;
}

@entityType("TestPage")
class TestPage extends Entity<TestPageData> {
    constructor(data: TestPageData) {
        super(data);
    }
}

interface TestNoteData extends EntityData {
    x: number;
    y: number;
    width: number;
    height: number;
    content: string;
    color: number[];
    tags: string[];
}

@entityType("TestNote")
class TestNote extends Entity<TestNoteData> {
    constructor(data: TestNoteData) {
        super(data);
    }
}

interface FixtureCase {
    name?: string;
    entities: SerializedEntityData[];
    deltas?: DeltaData[];
    expected_states?: SerializedEntityData[][];
    check_composition?: boolean;
}

function sortedEntityData(entitiesData: SerializedEntityData[]) {
    return [...entitiesData].sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    );
}

function entityData(store: InMemoryStore) {
    return sortedEntityData(Array.from(store.find()).map(entity => dumpToDict(entity)));
}

function assertEntityData(store: InMemoryStore, expected: SerializedEntityData[], message: string) {
    deepStrictEqual(entityData(store), sortedEntityData(expected), message);
}

function makeStore(entitiesData: SerializedEntityData[]) {
    const store = new InMemoryStore();
    for (const entityDict of entitiesData) {
        store.insertOne(loadFromDict(structuredClone(entityDict)));
    }
    return store;
}

function checkCompositionAndUndo(
    initialState: SerializedEntityData[],
    deltas: DeltaData[],
    sequentialFinalState: SerializedEntityData[],
) {
    // One squashed delta must reach the same state as replaying every delta.
    const squashedDelta = squashDeltas(deltas);
    const composedStore = makeStore(initialState);
    composedStore.applyDelta(squashedDelta);
    assertEntityData(composedStore, sequentialFinalState, "composed replay differs");

    // Undoing the squashed delta must restore the exact initial data.
    composedStore.applyDelta(squashedDelta.reversed());
    assertEntityData(composedStore, initialState, "composed inverse does not restore original entity data");

    // Undoing individual deltas, last to first, must restore the same data.
    const undoStore = makeStore(sequentialFinalState);
    for (const deltaData of [...deltas].reverse()) {
        const inverseDelta = new Delta(structuredClone(deltaData)).reversed();
        undoStore.applyDelta(inverseDelta);
    }
    assertEntityData(undoStore, initialState, "sequential inverses do not restore original entity data");
}

async function runFixture(fixture: FixtureCase) {
    const name = fixture.name ?? "fixture";
    const initialState = fixture.entities;
    const deltas = fixture.deltas ?? [];
    const expectedStates = fixture.expected_states;

    // State 0 is the initial data; each delta adds one expected state.
    if (expectedStates) {
        strictEqual(expectedStates.length, deltas.length + 1, "expected_states must include initial state and each replayed state");
    }
    const store = makeStore(initialState);
    const tree = await buildHashTree(store);

    async function checkStateAndHash(step: number) {
        if (expectedStates) {
            assertEntityData(store, expectedStates[step], `step ${step}: entity data mismatch`);
        }
        const rebuiltTree = await buildHashTree(store);
        strictEqual(tree.rootHash(), rebuiltTree.rootHash(), `step ${step}: incremental hash differs from rebuild`);
        console.log(`Checkpoint hash: ${name}:${step}:${tree.rootHash()}`);
    }

    console.log(`Case: ${name}; entities: ${initialState.length}; deltas: ${deltas.length}`);

    // Check the loaded state before replay, including model-induced data changes.
    await checkStateAndHash(0);

    // Replay in order, updating the hash tree alongside the store.
    for (const [index, deltaData] of deltas.entries()) {
        const delta = new Delta(structuredClone(deltaData));
        store.applyDelta(delta);
        await updateHashTree(tree, store, delta);

        // With expected states, check every step; otherwise check the final state.
        const step = index + 1;
        const isLastStep = step === deltas.length;
        if (expectedStates || isLastStep) {
            await checkStateAndHash(step);
        }
    }

    // Compare delta algebra against the sequential replay we just performed.
    if (fixture.check_composition) {
        checkCompositionAndUndo(initialState, deltas, entityData(store));
    }

    console.log(`Root hash: ${tree.rootHash()}`);
    console.log(`PASS: ${name}`);
}

async function main() {
    const here = dirname(fileURLToPath(import.meta.url));
    const fixturePath = process.argv[2]
        ? resolve(process.argv[2])
        : resolve(here, "fixtures", "fuzz-42.json");
    const cases: FixtureCase[] = JSON.parse(readFileSync(fixturePath, "utf-8"));

    // Finish all cases even when one fails, then fail the command.
    let failedCases = 0;
    for (const testCase of cases) {
        try {
            await runFixture(testCase);
        } catch (error) {
            failedCases++;
            const message = error instanceof Error ? error.message : String(error);
            console.log(`FAIL: ${testCase.name ?? "fixture"}: ${message}`);
        }
    }
    if (failedCases > 0) {
        process.exitCode = 1;
    }
}

main();
