import { Commit, CommitMetadata, CommitData } from "../version-control/Commit";
import { Repository, RepoUpdateData, verifyRepositoryIntegrity } from "../repository/Repository";
import { ChangeType } from "../../model/Change";
import { CommitGraph } from "../version-control/CommitGraph";
import { InternalRepoUpdate, InternalRepoUpdateNoDeltas } from "../repository/VcsAdapter";
import { Delta, DeltaData, squashDeltas } from "../../model/Delta";
import { getLogger } from "../../logging";

let log = getLogger('SyncUtils')

/**
 * The sync mechanism involves auto-merging and squashing in the commit graph.
 * Each node(=client/device) has its own branch in the repo. Whenever it adds
 * changes (commits) - that's only on its own branch. When a remote node
 * adds a commit and the local repo pulls - that's a non-conflicting change.
 * The local branch auto-merges (adds the commit to the local branch). When all
 * nodes advance to that commit - the history gets squashed. Commit ids are not
 * content based, so that doesn't affect the latest commits.
 * Actually all consecutive commits that don't include a head get squashed (in
 * order to reduce memory overhead).
 *
 * Special cases and conflict handling
 * * Branches are stored in an ordered faschion. The first ones in the list are
 * considered senior and the last ones - junior

 * - If two nodes add a commit together: the junior one reverts their commit
 *   and merges the senior branch commit. If there's a conflict between the two
 *   commits (same object, same key changed, etc) - the junior node removes
 *   the conflicting changes. Then it adds its own commit. Now that there's no
 *   conflict - the senior node merges the junior commit.
 */

export async function autoMergeForSync(repo: Repository, localBranchName: string) {
    /**
     * Merge remote commits into the local branch. Follow the rules outlined
     * in the sync procedure above (SyncUtils.ts)
     */
    log.info("Auto-merging for sync")
    let commitGraph = await repo.getCommitGraph()
    let branches = commitGraph.branches()

    let localBranchCommits = commitGraph.branchCommits(localBranchName)

    let seniorityMap = new Map<string, number>()
    branches.forEach((b, i) => seniorityMap.set(b.name, i))

    let seniorBranches = branches.sort((a, b) => seniorityMap.get(a.name)! - seniorityMap.get(b.name)!)
    let relevantBranches = seniorBranches.filter(b => b.name !== localBranchName)

    let commitsByBranch = new Map<string, CommitMetadata[]>()
    branches.forEach(b => commitsByBranch.set(b.name, commitGraph.branchCommits(b.name)))

    // * There should be a squash beforehand
    // Start from the root and go forward on all senior branches in parallel.
    // While there are relevant (senior) branches:
    let currentPos = 0
    while (relevantBranches.length !== 0) {
        // Drop senior branches that are behind (no commit at this pos)
        relevantBranches = relevantBranches.filter(b => commitsByBranch.get(b.name)!.length > currentPos)

        // Drop any branches that differ from the most senior one (from `relevant`)
        // * We sync only from the most senior one that's ahead. Ignore all else.

        // Get the last commit for each branch
        let currentCommits = relevantBranches.map(b => commitsByBranch.get(b.name)!.at(currentPos)!)

        let dominantCommitMetadata = currentCommits[0]
        for (let i = 1; i < currentCommits.length; i++) {
            if (currentCommits[i].id !== dominantCommitMetadata.id) {
                relevantBranches.splice(i, 1)
            }
        }

        // If the local commit's id is the same with the dominant - continue
        let localCommit = localBranchCommits.at(currentPos)
        if (localCommit && localCommit.id === dominantCommitMetadata.id) {
            currentPos++
            continue
        }

        // (else)
        // Merge the commit from the most senior
        // Get the full commit with a delta
        let responce = await repo.getCommits([dominantCommitMetadata.id])
        if (responce.length === 0) {
            throw new Error("Full commit info not found")
        }
        let dominantCommit = responce[0]

        // - If we're not past the local branch head - there's been a simultaneous
        //   state alteration - call the merge with revert=commitsAhead
        //   which would first revert the commits, then add the remote one, then
        //   re-add them with removed conflicting changes at the lvl1-keys (and new ids)
        //   * There should be max 2 local commits ahead btw - one squashed and one head.

        let commitsAheadCount = localBranchCommits.length - currentPos
        let commitsAheadMetadata = localBranchCommits.slice(currentPos, commitsAheadCount)
        let commitsAhead = await repo.getCommits(commitsAheadMetadata.map(c => c.id))

        // Start the merge

        // Revert commits from the local branch that are ahead
        if (commitsAheadCount > 0) {
            await repo.reset({ relativeToHead: -commitsAheadCount })
        }

        // Add the commit from the senior branch
        commitGraph = await repo.getCommitGraph();
        commitGraph.addCommit(dominantCommit.metadata())
        await repo.applyRepoUpdate({
            commitGraph: commitGraph.data(),
            upsertedCommits: [dominantCommit.data()]
        })


        // Remove conflicting changes from the local commits. I.e. we accept
        // remove any changes that touch the same entities (on update we only
        // remove first-key-level clashes)
        // On dominant delete - remove all commit deltas for that entity
        // On dominant update or create - remove create and delete commit entity
        // deltas. And leave only non-conflicting update 1lvl-keys
        const dominantDelta = dominantCommit.delta
        const dominantEntityIds = dominantDelta.entityIds()
        for (let localCommit of commitsAhead) {
            if (localCommit.deltaData === undefined) {
                throw new Error("Local commit delta data not found")
            }

            let localDelta = localCommit.delta
            for (let entityId of dominantEntityIds) {
                let localChange = localDelta.change(entityId)
                let dominantChange = dominantDelta.change(entityId)

                // Skip dominant entity deltas where there's no local
                if (localChange === undefined) {
                    continue
                }

                let localChangeType = localChange.type()
                let dominantChangeType = dominantChange!.type()
                // throw new Error("None of this is tested. The above line started giving an error after refactoring to Change from ChangeData")

                // Drop data for entity create/delete operations
                if (dominantChangeType === ChangeType.CREATE || dominantChangeType === ChangeType.DELETE) {
                    localCommit.delta.removeChange(entityId)
                } else if (dominantChangeType === ChangeType.UPDATE) {
                    // On dominant update
                    // Drop local delta if it's a create or delete
                    if (localChangeType === ChangeType.CREATE || localChangeType === ChangeType.DELETE) {
                        localCommit.delta.removeChange(entityId)
                    } else if (localChangeType === ChangeType.UPDATE) {
                        // Drop only keys that are present in the dominant
                        let dominantEntityDelta = dominantDelta.changeData(entityId)! // is in dominantDelta.entityIds
                        for (let key of Object.keys(dominantEntityDelta[0])) {
                            let forwardLC: any; // To avoid TS error
                            let reverseLC: any;
                            [, forwardLC, reverseLC] = localChange.data // components of the local entity delta
                            if (Object.prototype.hasOwnProperty.call(forwardLC, key)) {
                                delete forwardLC[key];
                                delete reverseLC[key];
                            }
                        }
                        localCommit.delta.removeChange(entityId)
                        localCommit.delta.addChange(localChange)
                    }
                }
            }
        }

        // Re-create the local commits with the removed conflicting changes
        // (and on top of the dominant commit, repo state respectively)
        if (commitsAhead.length > 0) {
            let refreshedCommits: Commit[] = []
            for (let localCommit of commitsAhead) {
                let commit = await repo.commit(localCommit.delta, localCommit.message)
                refreshedCommits.push(commit)
            }
            commitGraph.setBranch(localBranchName, refreshedCommits.at(-1)!.id)
            let localReaddUpdate: RepoUpdateData = {
                commitGraph: commitGraph.data(),
                upsertedCommits: refreshedCommits.map(c => c.data())
            }
            await repo.applyRepoUpdate(localReaddUpdate)
        }

        // Move the branch head
        let headCommitId: string;
        if (commitsAhead.length > 0) {
            headCommitId = commitsAhead.at(-1)!.id
        } else {
            headCommitId = dominantCommit.id
        }
        commitGraph.setBranch(localBranchName, headCommitId)

        // Advance one commit
        currentPos++;
    }
    log.info("Auto-merge done")
}


export function inferRepoChangesFromGraphs(localGraph: CommitGraph, remoteGraph: CommitGraph): InternalRepoUpdateNoDeltas {
    let localCommits = localGraph.commits();
    let remoteCommits = remoteGraph.commits();

    let localSet = new Set(localCommits.map((c) => c.id));
    let remoteSet = new Set(remoteCommits.map((c) => c.id));

    // Infer the removed commits
    let removedCommits = localCommits.filter((c) => !remoteSet.has(c.id));

    // Infer missing commits from the commit graph
    let addedCommits = remoteCommits.filter((c) => !localSet.has(c.id));

    // Detect updated commits (metadata differences for same id)
    // Only track parentId or snapshotHash changes (timestamp/message ignored)
    let updatedCommits = remoteCommits.filter((remoteC) => {
        if (!localSet.has(remoteC.id)) return false;
        let localC = localGraph.commit(remoteC.id);
        if (!localC) return false;  // Should never happen
        return (localC.parentId !== remoteC.parentId) || (localC.snapshotHash !== remoteC.snapshotHash);
    });

    // Infer the branch changes
    let localBranches = localGraph.branches();
    let remoteBranches = remoteGraph.branches();
    let localMap = new Map(localBranches.map((b) => [b.name, b]));
    let remoteMap = new Map(remoteBranches.map((b) => [b.name, b]));

    // Infer the removed branches
    let removedBranches = localBranches.filter((b) => !remoteMap.has(b.name));

    // Infer the added branches
    let addedBranches = remoteBranches.filter((b) => !localMap.has(b.name));

    // Infer the updated branches
    let updatedBranches = remoteBranches.filter((b) => {
        let localHead = localGraph.headCommit(b.name);
        let remoteHead = remoteGraph.headCommit(b.name);
        return localHead?.id !== remoteHead?.id;
    });

    return {
        addedCommits: addedCommits,
        removedCommits: removedCommits,
        updatedCommits: updatedCommits,
        addedBranches: addedBranches,
        updatedBranches: updatedBranches,
        removedBranches: removedBranches
    }
}


export function sanityCheckAndHydrateInternalRepoUpdate(
    repoUpdate: InternalRepoUpdateNoDeltas,
    upsertedCommitsWithDeltas: Commit[]
): InternalRepoUpdate {
    const {
        addedCommits,
        removedCommits,
        updatedCommits,
        addedBranches,
        updatedBranches,
        removedBranches
    } = repoUpdate;

    // Build id lookups from the slim diff
    const addedIds = new Set(addedCommits.map(c => c.id));
    const updatedIds = new Set(updatedCommits.map(c => c.id));

    const hydratedAdded: Commit[] = [];
    const hydratedUpdated: Commit[] = [];
    const unmatched: Commit[] = [];

    // Single pass over upserted payload: separate into added vs updated.
    // If an upserted commit isn't referenced in the slim diff, keep it aside and
    // treat it as "updated" defensively (e.g. K+1 reparent during squash).
    for (const commit of upsertedCommitsWithDeltas) {
        if (addedIds.has(commit.id)) {
            hydratedAdded.push(commit);
            addedIds.delete(commit.id);
        } else if (updatedIds.has(commit.id)) {
            hydratedUpdated.push(commit);
            updatedIds.delete(commit.id);
        } else {
            unmatched.push(commit);
        }
    }
    // Defensive fallback: any upserted commit not present in the slim diff is applied as updated.
    if (unmatched.length > 0) {
        throw new Error(`Unmatched upserted commits: ${unmatched.map(c => c.id).join(', ')}`);
    }

    // Validate all expected ids were hydrated
    if (addedIds.size > 0) {
        throw new Error(`Missing upserted commits for added ids: ${Array.from(addedIds).join(', ')}`);
    }
    if (updatedIds.size > 0) {
        throw new Error(`Missing upserted commits for updated ids: ${Array.from(updatedIds).join(', ')}`);
    }

    return {
        addedCommits: hydratedAdded,
        removedCommits,
        updatedCommits: hydratedUpdated,
        addedBranches,
        updatedBranches,
        removedBranches
    };
}

/**
 * Squash branch history using the K-centric algorithm.
 *
 * Squash algorithm (K-centric):
 * - Find largest K in the prefix with timestamp <= cutoff
 * - Aggregate deltas for [J..K] into ΔJK
 * - Update K: parentId := parent(J), deltaData := ΔJK, snapshotHash unchanged (== snapshot at K)
 * - Remove commits J..K-1
 * - Apply atomic repo update
 *
 * @param repo - The repository to squash
 * @param branchName - The branch name to squash
 * @param squashTtlMs - Time in milliseconds - commits older than this will be squashed
 * @returns Array of upserted commits (the updated K commit if squashing occurred)
 */
export async function squashBranchHistory(
    repo: Repository,
    branchName: string,
    squashTtlMs: number = 24 * 60 * 60 * 1000 // 24h default
): Promise<CommitData[]> {
    const graph = await repo.getCommitGraph();
    const commits = graph.branchCommits(branchName); // oldest -> newest

    if (commits.length < 2) {
        log.info('[squash] Less than two commits, skipping squash');
        return [];
    }

    const cutoff = Date.now() - squashTtlMs;

    // Find largest K such that commits[K].timestamp <= cutoff and the window starts at 0 (prefix)
    log.info('[squash] Finding K for cutoff:', cutoff, 'in commits:', commits.length);
    let K = -1;
    for (let i = 0; i < commits.length; i++) {
        if (commits[i].timestamp <= cutoff) {
            K = i;
        } else {
            break; // stop at first newer-than-cutoff
        }
    }

    // Need at least two old commits in the prefix (i.e., K >= 1)
    if (K <= 0) {
        log.info('[squash] No old commits to squash, skipping');
        return [];
    }

    const J = 0;
    const Jmeta = commits[J];
    const Kmeta = commits[K];

    // Aggregate deltas for commits [J..K]
    const idsToAggregate = commits.slice(J, K + 1).map(c => c.id);
    const fullForAggregate = await repo.getCommits(idsToAggregate);
    const aggregatedDelta = squashDeltas(fullForAggregate.map(c => c.deltaData));

    // Use the full K from the aggregate fetch to avoid another round-trip
    const Kfull = fullForAggregate[fullForAggregate.length - 1];

    // Build updated K: parentId changes to parent(J), snapshotHash stays (K end-state), delta becomes Δ(J..K)
    const updatedK = new Commit({
        id: Kfull.id,
        parent_id: Jmeta.parentId ?? null,
        snapshot_hash: Kfull.snapshotHash,     // end state unchanged
        delta_data: aggregatedDelta.data,      // composed J..K
        message: Kfull.message,               // or "squash J..K"
        timestamp: Kfull.timestamp            // keep K's timestamp
    });

    // Remove commits J..K-1 from the graph
    for (const meta of commits.slice(J, K)) {
        graph.removeCommit(meta.id);
    }

    // Update metadata for K in the graph (parentId changed)
    const kMetaOld = graph.commit(Kmeta.id);
    if (!kMetaOld) {
        throw new Error('[squash] K commit not found in graph');
    }
    const kMetaNew = new CommitMetadata({
        ...kMetaOld.data(),
        parent_id: Jmeta.parentId,
        // snapshotHash/timestamp/message remain aligned with updatedK
        snapshot_hash: updatedK.snapshotHash,
        timestamp: updatedK.timestamp,
        message: updatedK.message
    });
    graph.removeCommit(Kmeta.id);
    graph.addCommit(kMetaNew);

    // K+1 (if exists) remains parented to K; branch head naturally stays the same.
    // If everything is within [0..K] (i.e., K == last), head is already K — no change needed.

    const upsertedCommits = [updatedK.data()];

    // Apply the repo update through the repository API (infers removed/updated internally)
    const updateInfo: RepoUpdateData = {
        commitGraph: graph.data(),
        upsertedCommits
    };
    await repo.applyRepoUpdate(updateInfo);

    // Verify integrity post-squash
    const ok = await verifyRepositoryIntegrity(repo, branchName);
    log.info('Verified repository integrity after squash (K-centric):', ok);
    if (!ok) {
        throw new Error('[squash] Repository integrity verification failed after K-centric squash');
    }

    return upsertedCommits;
}

/**
 * Pure function to compute the delta needed to synchronize a local commit graph with a remote one.
 * This abstracts the core logic from Repository._applyInternalUpdateToCache for use in FDS.
 *
 * @param localGraph Current local commit graph
 * @param remoteGraph Target remote commit graph
 * @param upsertedCommits Commits from the remote that were added/updated
 * @param currentBranch Current branch name
 * @returns Delta to apply to get from local to remote state, or null if no changes needed
 */
export function computeRepoSyncDelta(
    localGraph: CommitGraph,
    remoteGraph: CommitGraph,
    upsertedCommits: Commit[],
    currentBranch: string
): Delta | null {
    let commitsBehind: string[] = [] // ids
    let remoteHeadCommit = remoteGraph.headCommit(currentBranch)
    let localHeadCommit = localGraph.headCommit(currentBranch)

    if (remoteHeadCommit) {
        let remoteHeadId = remoteHeadCommit.id
        let localHeadId = localHeadCommit ? localHeadCommit.id : null
        if (remoteHeadId !== localHeadId) {
            // Get the commits behind
            let behind = remoteGraph.commitsBetween(localHeadId, remoteHeadId)
            commitsBehind = behind.map((c) => c.id)
        }
    } else {
        if (localHeadCommit) {
            throw new Error("Irrational changes - remote branch empty, while local is not")
        }
    }

    if (commitsBehind.length === 0) {
        log.info('No new commits to apply to store.')
        return null;
    }

    // Create a lookup map for quick access to upserted commits
    const commitById = new Map<string, Commit>();
    upsertedCommits.forEach(commit => {
        commitById.set(commit.id, commit);
    });

    // Squash deltas from the commits behind
    let deltas: DeltaData[] = []

    for (let commitId of commitsBehind) {
        let commit = commitById.get(commitId)
        if (commit && commit.deltaData) {
            deltas.push(commit.deltaData)
        } else {
            throw new Error(`Critical: Missing commit or deltaData for ${commitId}`)
        }
    }

    // Return the squashed delta to apply
    return squashDeltas(deltas)
}
