import { InMemoryStore } from "../domain-store/InMemoryStore";
import { Change } from "../../model/Change";
import { Delta } from "../../model/Delta";
import { DummyPage, DummyNote } from "../test-utils";
import { HashTree, HangingSubtreesError, buildHashTree, updateHashTree } from "./HashTree";


describe("HashTree", () => {

    test("Empty tree has deterministic hash, adding nodes changes it", async () => {
        // Empty tree
        let tree = new HashTree();
        await tree.updateRootHash();
        let emptyHash = tree.rootHash();

        // Second empty tree produces the same hash
        let tree2 = new HashTree();
        await tree2.updateRootHash();
        expect(tree2.rootHash()).toEqual(emptyHash);

        // Super-root exists
        expect(tree.superRoot).not.toBeNull();
        expect(tree.nodes['']).toBe(tree.superRoot);

        // Add a root node — hash changes
        tree.createNode('root1', '', 'data1');
        await tree.updateRootHash();
        let oneRootHash = tree.rootHash();
        expect(oneRootHash).not.toEqual(emptyHash);

        // Add a child — hash changes again
        tree.createNode('child1', 'root1', 'cdata1');
        await tree.updateRootHash();
        let withChildHash = tree.rootHash();
        expect(withChildHash).not.toEqual(oneRootHash);

        // Add second root with child — hash changes again
        tree.createNode('root2', '', 'data2');
        tree.createNode('child2', 'root2', 'cdata2');
        await tree.updateRootHash();
        expect(tree.rootHash()).not.toEqual(withChildHash);

        // All 4 nodes + super-root in the index
        expect(Object.keys(tree.nodes).length).toBe(4 + 1);
    });

    test("Insertion order of children doesn't affect hash", async () => {
        let treeA = new HashTree();
        treeA.createNode('root', '', 'rdata');
        treeA.createNode('a', 'root', 'da');
        treeA.createNode('b', 'root', 'db');
        treeA.createNode('c', 'root', 'dc');
        await treeA.updateRootHash();

        let treeB = new HashTree();
        treeB.createNode('root', '', 'rdata');
        treeB.createNode('c', 'root', 'dc');
        treeB.createNode('a', 'root', 'da');
        treeB.createNode('b', 'root', 'db');
        await treeB.updateRootHash();

        expect(treeA.rootHash()).toEqual(treeB.rootHash());
    });

    test("Out-of-order insertion buffers and reattaches correctly", async () => {
        // Build reference tree in order
        let ref = new HashTree();
        ref.createNode('root', '', 'rd');
        ref.createNode('child', 'root', 'cd');
        ref.createNode('grandchild', 'child', 'gd');
        await ref.updateRootHash();

        // Build same tree completely backwards
        let tree = new HashTree();
        tree.createNode('grandchild', 'child', 'gd');
        tree.createNode('child', 'root', 'cd');
        tree.createNode('root', '', 'rd');
        await tree.updateRootHash();

        expect(tree.rootHash()).toEqual(ref.rootHash());
        // All nodes attached, no hanging subtrees (updateRootHash would have thrown)
        expect(Object.keys(tree.nodes).length).toBe(4); // super-root + 3
    });

    test("Hanging subtrees throw on updateRootHash", async () => {
        let tree = new HashTree();
        tree.createNode('orphan', 'nonexistent-parent', 'data');

        await expect(tree.updateRootHash()).rejects.toThrow(HangingSubtreesError);
    });

    test("Remove leaf, then subtree", async () => {
        let tree = new HashTree();
        tree.createNode('root', '', 'rd');
        tree.createNode('childA', 'root', 'da');
        tree.createNode('childB', 'root', 'db');
        await tree.updateRootHash();
        let fullHash = tree.rootHash();

        // Remove leaf childA
        tree.removeNode(tree.nodes['childA']);
        await tree.updateRootHash();
        let afterLeafRemoval = tree.rootHash();
        expect(afterLeafRemoval).not.toEqual(fullHash);
        expect(tree.nodes['childA']).toBeUndefined();

        // Remove root + childB (whole subtree)
        tree.removeNode(tree.nodes['childB']);
        tree.removeNode(tree.nodes['root']);
        await tree.updateRootHash();
        expect(tree.nodes['root']).toBeUndefined();
        expect(tree.nodes['childB']).toBeUndefined();

        // Back to empty tree hash
        let emptyTree = new HashTree();
        await emptyTree.updateRootHash();
        expect(tree.rootHash()).toEqual(emptyTree.rootHash());
    });

    test("Remove parent with live child throws", async () => {
        let tree = new HashTree();
        tree.createNode('root', '', 'rd');
        tree.createNode('child', 'root', 'cd');
        await tree.updateRootHash();

        // Mark only the parent for removal (child still alive)
        tree.removeNode(tree.nodes['root']);
        await expect(tree.updateRootHash()).rejects.toThrow("Cannot remove node with children");
    });

    test("Duplicate entity id rejected", async () => {
        let tree = new HashTree();
        tree.createNode('x', '', 'data');
        expect(() => tree.createNode('x', '', 'other')).toThrow("already exists");
    });

    test("buildHashTree and updateHashTree produce consistent hashes", async () => {
        let store = new InMemoryStore();

        // Insert entities into store
        let page1 = new DummyPage({ id: 'p1', parent_id: '', name: 'Page1' });
        let page2 = new DummyPage({ id: 'p2', parent_id: '', name: 'Page2' });
        let note1 = new DummyNote({ id: 'n1', parent_id: 'p1', testProp: 'hello' });
        let note2 = new DummyNote({ id: 'n2', parent_id: 'p1', testProp: 'world' });
        let note3 = new DummyNote({ id: 'n3', parent_id: 'p2', testProp: 'foo' });

        let createChanges = [
            store.insertOne(page1),
            store.insertOne(page2),
            store.insertOne(note1),
            store.insertOne(note2),
            store.insertOne(note3),
        ];

        // Build from scratch
        let builtTree = await buildHashTree(store);
        let builtHash = builtTree.rootHash();

        // Build incrementally via updateHashTree
        let incTree = new HashTree();
        let createDelta = Delta.fromChanges(createChanges);
        await updateHashTree(incTree, store, createDelta);
        expect(incTree.rootHash()).toEqual(builtHash);

        // UPDATE: change a note in the store, apply delta
        let note1old = store.findOne({ id: 'n1' })!;
        let note1new = note1old.copy() as DummyNote;
        note1new.testProp = 'updated';
        let updateChange = Change.update(note1old, note1new);
        store.updateOne(note1new);
        let updateDelta = Delta.fromChanges([updateChange]);

        await updateHashTree(incTree, store, updateDelta);
        let updatedHash = incTree.rootHash();
        expect(updatedHash).not.toEqual(builtHash);

        // Rebuild from mutated store — should match incremental
        let rebuiltTree = await buildHashTree(store);
        expect(rebuiltTree.rootHash()).toEqual(updatedHash);
    });

    test("Full lifecycle: create, update, delete via deltas with reverse", async () => {
        let store = new InMemoryStore();

        // Create
        let page = new DummyPage({ id: 'p1', parent_id: '', name: 'P1' });
        let note = new DummyNote({ id: 'n1', parent_id: 'p1', testProp: 'original' });
        let createChanges = [store.insertOne(page), store.insertOne(note)];
        let createDelta = Delta.fromChanges(createChanges);

        let tree = new HashTree();
        await updateHashTree(tree, store, createDelta);
        let afterCreate = tree.rootHash();

        // Update the note
        let noteOld = store.findOne({ id: 'n1' })!;
        let noteNew = noteOld.copy() as DummyNote;
        noteNew.testProp = 'modified';
        let updateChange = Change.update(noteOld, noteNew);
        store.updateOne(noteNew);
        let updateDelta = Delta.fromChanges([updateChange]);
        await updateHashTree(tree, store, updateDelta);
        let afterUpdate = tree.rootHash();
        expect(afterUpdate).not.toEqual(afterCreate);

        // Delete the note
        let noteForDelete = store.findOne({ id: 'n1' })!;
        let deleteDelta = Delta.fromChanges([store.removeOne(noteForDelete)]);
        await updateHashTree(tree, store, deleteDelta);
        let afterDelete = tree.rootHash();
        expect(afterDelete).not.toEqual(afterUpdate);

        // Reverse all three deltas to get back to empty
        // Apply in reverse order: undo delete, undo update, undo create

        // Undo delete (re-insert note)
        let undoDelete = deleteDelta.reversed();
        // We need to re-insert the entity in the store for updateHashTree to find it
        store.insertOne(noteForDelete);
        await updateHashTree(tree, store, undoDelete);

        // Undo update (revert note prop)
        let undoUpdate = updateDelta.reversed();
        // Revert in store: current is 'original' (re-inserted), target is 'modified' old state
        // Actually the reversed delta's forward component restores the old state
        let currentNote = store.findOne({ id: 'n1' })!;
        let revertedNote = currentNote.copy() as DummyNote;
        revertedNote.testProp = 'modified';
        store.updateOne(revertedNote);
        await updateHashTree(tree, store, undoUpdate);

        // Undo create (remove both entities)
        let undoCreate = createDelta.reversed();
        store.removeOne(store.findOne({ id: 'n1' })!);
        store.removeOne(store.findOne({ id: 'p1' })!);
        await updateHashTree(tree, store, undoCreate);

        // Should be back to empty tree hash
        let emptyTree = new HashTree();
        await emptyTree.updateRootHash();
        expect(tree.rootHash()).toEqual(emptyTree.rootHash());
    });

    test("updateHashTree handles reparenting (parent_id change in UPDATE)", async () => {
        let store = new InMemoryStore();

        // Create two pages and a note under page1
        let page1 = new DummyPage({ id: 'p1', parent_id: '', name: 'Page1' });
        let page2 = new DummyPage({ id: 'p2', parent_id: '', name: 'Page2' });
        let note = new DummyNote({ id: 'n1', parent_id: 'p1', testProp: 'hello' });

        let createChanges = [
            store.insertOne(page1),
            store.insertOne(page2),
            store.insertOne(note),
        ];
        let tree = new HashTree();
        await updateHashTree(tree, store, Delta.fromChanges(createChanges));

        // Move note from page1 to page2 via an UPDATE that changes parent_id
        let noteOld = store.findOne({ id: 'n1' })! as DummyNote;
        let noteNew = new DummyNote({ id: 'n1', parent_id: 'p2', testProp: 'hello' });
        let updateChange = Change.update(noteOld, noteNew);
        store.updateOne(noteNew);
        let updateDelta = Delta.fromChanges([updateChange]);
        await updateHashTree(tree, store, updateDelta);

        // Incremental result must match a fresh build from the same store
        let rebuilt = await buildHashTree(store);
        expect(tree.rootHash()).toEqual(rebuilt.rootHash());

        // Verify the node is actually under p2 now
        let p2Node = tree.nodes['p2'];
        expect(p2Node.children['n1']).toBeDefined();
        let p1Node = tree.nodes['p1'];
        expect(p1Node.children['n1']).toBeUndefined();
    });
});
