import { InMemoryStore } from "../domain-store/InMemoryStore";
import { Change } from "../../model/Change";
import { Commit } from "../version-control/Commit";
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

    test("Commit", async () => {
        // The repo is created in beforeEach
        let initialHash = repo.hashTree.rootHash()
        // console.log('Initial hash:', initialHash)

        let sourceStore = new InMemoryStore()

        let changes: Change[] = [
            sourceStore.insertOne(new DummyPage({ id: 'page1', parent_id: '', name: 'Page 1' })),
            sourceStore.insertOne(new DummyNote({ id: 'entity1', testProp: 'entity1', parent_id: 'page1' })),
        ]
                let delta = Delta.fromChanges(changes)
        let commit: Commit
        try{
            commit = await repo.commit(delta, 'Initial commit')
        } catch (e) {
            throw Error ('Error committing' + e)
        }


        let hashAfterCommit = repo.hashTree.rootHash()
        console.log('Hash after commit:', hashAfterCommit)

        expect(commit.snapshotHash).toEqual(hashAfterCommit)
        expect(hashAfterCommit).not.toEqual(initialHash)

        // Reverse
        let reverseDelta = delta.reversed()
        let reverseCommit: Commit
        try {
            reverseCommit = await repo.commit(reverseDelta, 'Reverse commit')
        } catch (e) {
            console.log(e)
            throw e
        }
        let hashAfterReverseCommit = repo.hashTree.rootHash()

        expect(reverseCommit.snapshotHash).toEqual(hashAfterReverseCommit)
        expect(hashAfterReverseCommit).toEqual(initialHash)
    });

    test("Pull same branch", async () => {
        const config2: VcsAdapterConfig = {
            name: 'InMemory',
            args: {
                localBranchName: 'dev1',
                projectId: createId()
            }
        };
        let repo2 = await Repository.create(config2, true);

        // Add some data to repo1
        let sourceStore = new InMemoryStore()

        let changes: Change[] = [
            sourceStore.insertOne(new DummyPage({ id: 'page1' , parent_id:'', name: 'Page 1' })),
            sourceStore.insertOne(new DummyNote({ id: 'entity1', testProp: 'entity1', parent_id: 'page1' })),
        ]

        let delta = Delta.fromChanges(changes)
        await repo.commit(delta, 'Initial commit')

        // Pull from repo1 to repo2
        await repo2.pull(repo)

        let hash1 = repo.hashTree.rootHash()
        let hash2 = repo2.hashTree.rootHash()
        expect(hash1).toEqual(hash2)

        // Make a change in repo2 (generate the change outside of it, since
        // the async repo does not have a way to directly alter entities in the
        // head store)
        let changes2: Change[] = [
            sourceStore.insertOne(new DummyNote({ id: 'entity2', testProp: 'entity2', parent_id: 'page1' })),
        ]
        let delta2 = Delta.fromChanges(changes2)
        await repo2.commit(delta2, 'Second commit')

        // Pull from repo2 to repo1
        await repo.pull(repo2)

        let hashAfterChange = repo2.hashTree.rootHash()
        let hashAfterPull = repo.hashTree.rootHash()
        expect(hashAfterChange).toEqual(hashAfterPull)
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

        // Log the state before commit
        console.log('Store state before removal:', Array.from(repo.headStore.find({})))
        console.log('Hash tree before removal:', repo.hashTree)

        let commit = await repo.commit(delta2, 'Remove page1 and entity1')

        // Log the state after commit
        console.log('Store state after removal:', Array.from(repo.headStore.find({})))
        console.log('Hash tree after removal:', repo.hashTree)
        console.log('Commit snapshot hash:', commit.snapshotHash)

        // Recreate the hash tree and check that it's the same as the original
        let hashTree = await buildHashTree(repo.headStore)
        let rootHash = hashTree.rootHash()
        console.log('Rebuilt hash tree root hash:', rootHash)
        console.log('Rebuilt hash tree:', hashTree)
        console.log('Head store', repo.headStore.data())

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

    // Add sync with conflict
    // Automerge
});
