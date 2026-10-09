import { InMemoryStore } from "../domain-store/InMemoryStore";
import { Change } from "../../model/Change";
import { buildHashTree } from "../version-control/HashTree";
import { Delta } from "../../model/Delta";
import { Repository, VcsAdapterConfig } from "sivkit/storage/repository/Repository";
import { createId } from "../../util/base";
import { DummyPage, DummyNote } from "../test-utils";



describe("Repository base functionality", () => {
    let repo: Repository;

    beforeEach(async () => {
        const config: VcsAdapterConfig = {
            name: 'InMemory',
            args: {
                localBranchName: 'dev1',
                projectId: createId()
            }
        };
        repo = await Repository.create(config, true);
    });

    afterEach(() => repo.close());

    test("Commit and inverse restore entity data and hash", async () => {
        const initialHash = repo.hashTree.rootHash();
        const page = new DummyPage({ id: 'page1', parent_id: '', name: 'Page 1' });
        const note = new DummyNote({ id: 'entity1', testProp: 'entity1', parent_id: page.id });
        const delta = Delta.fromChanges([Change.create(page), Change.create(note)]);
        const commit = await repo.commit(delta, 'Initial commit');

        expect([...repo.headStore.find()]).toEqual([page, note]);
        expect(commit.snapshotHash).toEqual(repo.hashTree.rootHash());
        expect(commit.snapshotHash).not.toEqual(initialHash);

        const reverseCommit = await repo.commit(delta.reversed(), 'Reverse commit');
        expect([...repo.headStore.find()]).toEqual([]);
        expect(reverseCommit.snapshotHash).toEqual(repo.hashTree.rootHash());
        expect(reverseCommit.snapshotHash).toEqual(initialHash);
    });

    test("Pull same branch", async () => {
        const config2: VcsAdapterConfig = {
            name: 'InMemory',
            args: {
                localBranchName: 'dev1',
                projectId: createId()
            }
        };
        const repo2 = await Repository.create(config2, true);
        try {
            const sourceStore = new InMemoryStore();
            const changes = [
                sourceStore.insertOne(new DummyPage({ id: 'page1', parent_id: '', name: 'Page 1' })),
                sourceStore.insertOne(new DummyNote({ id: 'entity1', testProp: 'entity1', parent_id: 'page1' })),
            ];
            await repo.commit(Delta.fromChanges(changes), 'Initial commit');

            await repo2.pull(repo);
            expect(repo2.hashTree.rootHash()).toEqual(repo.hashTree.rootHash());
            expect(repo2.headStore.data()).toEqual(sourceStore.data());

            // Generate the change outside the async repo's read-only head store.
            const change = sourceStore.insertOne(
                new DummyNote({ id: 'entity2', testProp: 'entity2', parent_id: 'page1' }),
            );
            await repo2.commit(Delta.fromChanges([change]), 'Second commit');

            await repo.pull(repo2);
            expect(repo.hashTree.rootHash()).toEqual(repo2.hashTree.rootHash());
            expect(repo.headStore.data()).toEqual(sourceStore.data());
            expect(repo2.headStore.data()).toEqual(sourceStore.data());
        } finally {
            repo2.close();
        }
    });

    test("Remove page with note and do integrity check", async () => {
        // The repo is created in beforeEach. We can just use it

        let sourceStore = new InMemoryStore()
        let changes: Change[] = [
            sourceStore.insertOne(new DummyPage({ id: 'page1', parent_id:'', name: 'Page 1' })),
            sourceStore.insertOne(new DummyNote({ id: 'entity1', testProp: 'entity1', parent_id: 'page1' })),
            sourceStore.insertOne(new DummyPage({ id: 'page2' , parent_id:'', name: 'Page 2' })),
            sourceStore.insertOne(new DummyNote({ id: 'entity2', testProp: 'entity2', parent_id: 'page2' })),
        ]
        let delta = Delta.fromChanges(changes)
        await repo.commit(delta, 'Initial commit')

        // Remove the first page and its note
        const page1 = sourceStore.findOne({ id: 'page1' })
        const entity1 = sourceStore.findOne({ id: 'entity1' })

        // assert page1 and the entity are found
        expect(page1).toBeTruthy()
        expect(entity1).toBeTruthy()

        let changes2: Change[] = [
            sourceStore.removeOne(page1!),
            sourceStore.removeOne(entity1!),
        ]

        let delta2 = Delta.fromChanges(changes2)

        let commit = await repo.commit(delta2, 'Remove page1 and entity1')
        expect([...repo.headStore.find()]).toEqual([
            new DummyPage({ id: 'page2', parent_id: '', name: 'Page 2' }),
            new DummyNote({ id: 'entity2', parent_id: 'page2', testProp: 'entity2' }),
        ]);

        // Recreate the hash tree and check that it's the same as the original
        let hashTree = await buildHashTree(repo.headStore)
        let rootHash = hashTree.rootHash()

        expect(rootHash).toEqual(commit.snapshotHash)
    });

    test("Commit with skipConflictingChanges applies a stale update on the current base", async () => {
        const sourceStore = new InMemoryStore();
        const page = new DummyPage({ id: 'page1', parent_id: '', name: 'Page 1' });
        const baseDelta = Delta.fromChanges([sourceStore.insertOne(page)]);
        await repo.commit(baseDelta, 'Initial commit');

        const remotePage = page.copy() as DummyPage;
        remotePage.name = 'Remote Page';
        const remoteDelta = Delta.fromChanges([Change.update(page, remotePage)]);
        await repo.commit(remoteDelta, 'Remote update');

        const staleLocalPage = page.copy() as DummyPage;
        staleLocalPage.name = 'Local Page';
        const staleDelta = Delta.fromChanges([Change.update(page, staleLocalPage)]);

        const commit = await repo.commit(staleDelta, 'Stale local update', {
            skipConflictingChanges: true,
        });
        const appliedDelta = commit.delta;

        expect(appliedDelta.isEmpty()).toBe(false);
        expect(commit.deltaData).toEqual(appliedDelta.data);
        expect((appliedDelta.change('page1')?.reverseComponent as { name?: string } | undefined)?.name).toBe('Remote Page');
        expect((repo.headStore.findOne({ id: 'page1' }) as DummyPage | undefined)?.name).toBe('Local Page');
    });

});
