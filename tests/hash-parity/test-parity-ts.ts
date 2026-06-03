/**
 * Hash parity test — TypeScript side.
 *
 * Loads a fixture JSON, inserts entities into an InMemoryStore,
 * builds a HashTree, and prints the root hash.
 *
 * If the fixture contains "deltas", applies each one sequentially via
 * updateHashTree and prints the final root hash after all deltas.
 *
 * Usage:
 *     npx tsx test-parity-ts.ts [fixture.json]
 *
 * Defaults to fixtures/fuzz-42.json if no argument given.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Entity, EntityData, entityType, loadFromDict } from "../../js-src/src/model/Entity";
import { Delta, DeltaData } from "../../js-src/src/model/Delta";
import { InMemoryStore } from "../../js-src/src/storage/domain-store/InMemoryStore";
import { buildHashTree, updateHashTree } from "../../js-src/src/storage/version-control/HashTree";

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

// ── Main ──

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = process.argv[2]
    ? resolve(process.argv[2])
    : resolve(__dirname, "fixtures", "fuzz-42.json");

const fixture = JSON.parse(readFileSync(fixturePath, "utf-8"));
const entitiesData = fixture.entities;

async function main() {
    const store = new InMemoryStore();

    for (const entityDict of entitiesData) {
        const entity = loadFromDict(entityDict);
        store.insertOne(entity);
    }

    let tree = await buildHashTree(store);
    let rootHash = tree.rootHash();

    console.log(`Entities: ${entitiesData.length}`);
    console.log(`Build root hash: ${rootHash}`);

    // Apply deltas if present (tests updateHashTree)
    const deltas: DeltaData[] = fixture.deltas ?? [];
    if (deltas.length > 0) {
        console.log(`\nApplying ${deltas.length} deltas...`);
        for (const deltaData of deltas) {
            const delta = new Delta(deltaData);
            store.applyDelta(delta);
            await updateHashTree(tree, store, delta);
        }

        const finalHash = tree.rootHash();
        console.log(`Final root hash (after deltas): ${finalHash}`);

        // Verify incremental update matches full rebuild
        const rebuiltTree = await buildHashTree(store);
        const rebuiltHash = rebuiltTree.rootHash();
        if (finalHash === rebuiltHash) {
            console.log("PASS: incremental update matches full rebuild");
        } else {
            console.log(`FAIL: incremental=${finalHash} vs rebuild=${rebuiltHash}`);
            process.exit(1);
        }

        rootHash = finalHash;
    }

    console.log(`\nRoot hash: ${rootHash}`);
}

main();
