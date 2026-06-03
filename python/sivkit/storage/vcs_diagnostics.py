"""Diagnostic utilities for VCS hash mismatches.

Provides tools to locate the first commit where the stored snapshot hash
diverges from a freshly computed one, using binary search over the commit
history.
"""

from __future__ import annotations

import math
import time
from collections.abc import Callable, Generator
from dataclasses import dataclass
from typing import Any, Literal

from sivkit import get_logger
from sivkit.storage.commit import Commit, CommitMetadata
from sivkit.storage.delta import Delta
from sivkit.storage.hash_tree import HashTree, build_hash_tree, update_hash_tree
from sivkit.storage.in_memory_store import InMemoryStore
from sivkit.storage.vcs_adapter import InternalRepoUpdate, VcsAdapter

log = get_logger(__name__)


def _replay_to(commits: list[Commit], end_index: int) -> InMemoryStore:
    """Replay commits [0..end_index] into a fresh store."""
    store = InMemoryStore()
    total = end_index + 1
    for i, commit in enumerate(commits[: end_index + 1]):
        delta = Delta.from_data(commit.delta_data)
        store.apply_delta(delta)
        if (i + 1) % 500 == 0:
            print(f"\rReplaying {i + 1} / {total} commits", end="", flush=True)
    if total >= 500:
        print()  # newline after progress
    return store


def diagnose_hash_mismatch(
    adapter: VcsAdapter,
    branch_name: str,
    computed_hash: str,
    stored_hash: str,
    on_progress: Callable[[int, int], None] | None = None,
) -> dict[str, Any]:
    """Diagnose why the head store hash doesn't match the stored commit hash.

    Performs a binary search over the commit history to find the first commit
    whose stored snapshot_hash disagrees with a fresh build_hash_tree of the
    replayed state up to that point.

    Args:
        adapter: The VcsAdapter to read commits from.
        branch_name: The branch being checked.
        computed_hash: The hash computed by build_hash_tree on the hydrated
            head store.
        stored_hash: The snapshot_hash from the last commit.
        on_progress: Optional callback(step, total_steps) called after each
            binary search step.

    Returns:
        A dict with diagnostic info.
    """
    diag: dict[str, Any] = {
        "run_timestamp": time.time(),
        "branch_name": branch_name,
        "hydration_computed_hash": computed_hash,
        "stored_hash": stored_hash,
        "first_bad_commit": None,
        "diagnosis": None,
    }

    # Load the full commit chain
    graph = adapter.get_commit_graph()
    branch = graph.branch(branch_name)
    if branch is None or branch.head_commit_id is None:
        diag["diagnosis"] = "empty_branch"
        return diag

    commit_metas = graph.branch_commits(branch_name)
    commit_ids = [c.id for c in commit_metas]
    commits = adapter.get_commits(commit_ids)
    total = len(commits)
    diag["total_commits"] = total

    log.info("Hash-mismatch diagnostic: %d commits on branch %s", total, branch_name)

    # --- Step 1: full replay + rebuild to check if stored hash is reachable ---
    log.info("Diagnostic: replaying all %d commits...", total)
    if on_progress:
        on_progress(0, 0)  # signal: full replay started (total unknown yet)
    replay_store = _replay_to(commits, total - 1)
    replay_hash = build_hash_tree(replay_store).root_hash()
    replay_entity_count = len(list(replay_store.find()))

    diag["replay_rebuild_hash"] = replay_hash
    diag["replay_entity_count"] = replay_entity_count

    log.info(
        "Diagnostic: replay done. rebuild_hash=%s, stored_hash=%s, "
        "hydration_hash=%s, entity_count=%d",
        replay_hash,
        stored_hash,
        computed_hash,
        replay_entity_count,
    )

    if replay_hash == stored_hash:
        # Replaying deltas and rebuilding matches the stored hash. So the
        # hydration path itself produced a different result — likely an entity
        # class registration issue or load_from_dict round-trip problem.
        diag["diagnosis"] = (
            "rebuild_matches_stored: replaying deltas from scratch produces "
            "the stored hash. The hydration's build_hash_tree diverged — "
            "check entity class registration / load_from_dict round-trip."
        )
        return diag

    if replay_hash == computed_hash:
        # Both fresh replays agree with each other but not with the stored
        # hash. The stored hash was computed by a different implementation
        # (likely TS). Cross-language hash parity issue.
        diag["diagnosis"] = (
            "rebuild_matches_hydration: both Python replays agree but differ "
            "from the stored hash. The stored hash was likely computed by a "
            "different implementation (TS). Check cross-language hash parity."
        )
        # Continue to binary search to find when the divergence started
    else:
        diag["diagnosis"] = (
            "all_three_differ: hydration, replay, and stored hashes all "
            "differ. This is unexpected — possible entity class or delta "
            "replay non-determinism."
        )

    # --- Step 2: binary search for first divergent commit ---
    log.info("Diagnostic: binary-searching %d commits for first divergence", total)

    total_steps = math.ceil(math.log2(total)) + 1 if total > 1 else 1

    lo, hi = 0, total - 1
    bad_index: int | None = None
    step = 0

    while lo <= hi:
        mid = (lo + hi) // 2
        mid_store = _replay_to(commits, mid)
        mid_hash = build_hash_tree(mid_store).root_hash()
        mid_stored = commits[mid].snapshot_hash

        matches = (not mid_stored) or (mid_hash == mid_stored)

        if not matches:
            bad_index = mid
            hi = mid - 1
        else:
            lo = mid + 1

        step += 1
        if on_progress:
            on_progress(step, total_steps)

        log.info(
            "Diagnostic: bsearch lo=%d hi=%d mid=%d match=%s",
            lo,
            hi,
            mid,
            matches,
        )

    if bad_index is not None:
        bad_commit = commits[bad_index]
        bad_store = _replay_to(commits, bad_index)
        bad_hash = build_hash_tree(bad_store).root_hash()
        bad_entity_count = len(list(bad_store.find()))

        diag["first_bad_commit"] = {
            "index": bad_index,
            "commit_id": bad_commit.id,
            "message": bad_commit.message,
            "timestamp": bad_commit.timestamp,
            "stored_snapshot_hash": bad_commit.snapshot_hash,
            "computed_snapshot_hash": bad_hash,
            "delta_data": bad_commit.delta_data,
            "delta_entity_count": len(bad_commit.delta_data),
            "entity_count_at_commit": bad_entity_count,
        }
        log.error(
            "Diagnostic: first bad commit at index %d / %d (id=%s): "
            "computed=%s stored=%s",
            bad_index,
            total,
            bad_commit.id,
            bad_hash,
            bad_commit.snapshot_hash,
        )
    else:
        diag["diagnosis"] += (
            " Binary search did not isolate a single bad commit — "
            "possible non-monotonic divergence."
        )

    return diag


def diagnose_hash_mismatch_gen(
    adapter: VcsAdapter,
    branch_name: str,
    computed_hash: str,
    stored_hash: str,
) -> Generator[dict[str, Any], None, None]:
    """Generator version of diagnose_hash_mismatch that yields progress.

    Yields dicts with type="progress" (step, totalSteps) during binary search,
    then a final dict with type="result" containing the diagnostic data.
    """
    import math

    diag: dict[str, Any] = {
        "run_timestamp": time.time(),
        "branch_name": branch_name,
        "hydration_computed_hash": computed_hash,
        "stored_hash": stored_hash,
        "first_bad_commit": None,
        "diagnosis": None,
    }

    graph = adapter.get_commit_graph()
    branch = graph.branch(branch_name)
    if branch is None or branch.head_commit_id is None:
        diag["diagnosis"] = "empty_branch"
        yield {"type": "result", "data": diag}
        return

    commit_metas = graph.branch_commits(branch_name)
    commit_ids = [c.id for c in commit_metas]
    commits = adapter.get_commits(commit_ids)
    total = len(commits)
    diag["total_commits"] = total

    # Step 0: full replay
    total_steps = (math.ceil(math.log2(total)) + 1 if total > 1 else 1) + 1
    yield {
        "type": "progress",
        "step": 0,
        "totalSteps": total_steps,
        "phase": "full_replay",
    }

    replay_store = _replay_to(commits, total - 1)
    replay_hash = build_hash_tree(replay_store).root_hash()
    replay_entity_count = len(list(replay_store.find()))

    diag["replay_rebuild_hash"] = replay_hash
    diag["replay_entity_count"] = replay_entity_count

    if replay_hash == stored_hash:
        diag["diagnosis"] = (
            "rebuild_matches_stored: replaying deltas from scratch produces "
            "the stored hash. The hydration's build_hash_tree diverged — "
            "check entity class registration / load_from_dict round-trip."
        )
        yield {"type": "result", "data": diag}
        return

    if replay_hash == computed_hash:
        diag["diagnosis"] = (
            "rebuild_matches_hydration: both Python replays agree but differ "
            "from the stored hash. The stored hash was likely computed by a "
            "different implementation (TS). Check cross-language hash parity."
        )
    else:
        diag["diagnosis"] = (
            "all_three_differ: hydration, replay, and stored hashes all "
            "differ. This is unexpected — possible entity class or delta "
            "replay non-determinism."
        )

    # Binary search
    lo, hi = 0, total - 1
    bad_index: int | None = None
    step = 1

    while lo <= hi:
        mid = (lo + hi) // 2
        mid_store = _replay_to(commits, mid)
        mid_hash = build_hash_tree(mid_store).root_hash()
        mid_stored = commits[mid].snapshot_hash

        matches = (not mid_stored) or (mid_hash == mid_stored)

        if not matches:
            bad_index = mid
            hi = mid - 1
        else:
            lo = mid + 1

        yield {
            "type": "progress",
            "step": step,
            "totalSteps": total_steps,
            "phase": "binary_search",
        }
        step += 1

    if bad_index is not None:
        bad_commit = commits[bad_index]
        bad_store = _replay_to(commits, bad_index)
        bad_hash = build_hash_tree(bad_store).root_hash()
        bad_entity_count = len(list(bad_store.find()))

        diag["first_bad_commit"] = {
            "index": bad_index,
            "commit_id": bad_commit.id,
            "message": bad_commit.message,
            "timestamp": bad_commit.timestamp,
            "stored_snapshot_hash": bad_commit.snapshot_hash,
            "computed_snapshot_hash": bad_hash,
            "delta_data": bad_commit.delta_data,
            "delta_entity_count": len(bad_commit.delta_data),
            "entity_count_at_commit": bad_entity_count,
        }
    else:
        diag["diagnosis"] += (
            " Binary search did not isolate a single bad commit — "
            "possible non-monotonic divergence."
        )

    yield {"type": "result", "data": diag}


def test_hash_parity(
    adapter: VcsAdapter,
    branch_name: str,
    check_interval: int = 1000,
) -> dict[str, Any]:
    """Test build_hash_tree vs incremental update_hash_tree parity.

    Replays commits with incremental hash tree updates and periodically
    compares the incremental hash with a from-scratch rebuild.

    Args:
        adapter: The VcsAdapter to read commits from.
        branch_name: The branch to check.
        check_interval: How often (in commits) to compare build vs update.

    Returns:
        A dict with parity check results.
    """
    graph = adapter.get_commit_graph()
    branch = graph.branch(branch_name)
    if branch is None or branch.head_commit_id is None:
        return {"error": "empty_branch", "branch_name": branch_name}

    commit_metas = graph.branch_commits(branch_name)
    commit_ids = [c.id for c in commit_metas]
    commits = adapter.get_commits(commit_ids)
    total = len(commits)

    result: dict[str, Any] = {
        "branch_name": branch_name,
        "total_commits": total,
        "check_interval": check_interval,
        "checks": [],
        "stored_hash_failures": [],
        "rebuild_failures": [],
        "update_errors": [],
    }

    store = InMemoryStore()
    tree = HashTree()

    for i, commit in enumerate(commits):
        delta = Delta.from_data(commit.delta_data)
        applied = store.apply_delta(delta)

        if (i + 1) % 100 == 0:
            print(f"\rParity: replaying commit {i + 1} / {total}", end="", flush=True)

        try:
            update_hash_tree(tree, store, applied)
        except Exception as exc:
            result["update_errors"].append(
                {
                    "index": i,
                    "commit_id": commit.id,
                    "error": f"update_hash_tree failed: {exc}",
                }
            )
            log.error(
                "Parity check: update_hash_tree error at commit %d (id=%s): %s",
                i,
                commit.id,
                exc,
            )
            # Rebuild tree from scratch so we can continue
            tree = HashTree()
            for node in build_hash_tree(store)._nodes.values():
                tree._nodes[node.entity_id] = node
            continue

        incremental_hash = tree.root_hash()

        # Check stored hash (skip non-hex placeholders like "snap")
        stored = commit.snapshot_hash
        is_valid_hex = (
            stored
            and len(stored) == 64
            and all(c in "0123456789abcdef" for c in stored)
        )
        if is_valid_hex and incremental_hash != stored:
            is_empty = len(commit.delta_data) == 0
            result["stored_hash_failures"].append(
                {
                    "index": i,
                    "commit_id": commit.id,
                    "message": commit.message,
                    "incremental_hash": incremental_hash,
                    "stored_hash": stored,
                    "empty_delta": is_empty,
                    "delta_keys": len(commit.delta_data),
                }
            )
            log.warning(
                "Parity check: incremental != stored at commit %d (id=%s, "
                "msg=%r, empty=%s)",
                i,
                commit.id,
                commit.message,
                is_empty,
            )

        # Periodically compare incremental vs rebuild
        if (i + 1) % check_interval == 0 or i == total - 1:
            rebuild_hash = build_hash_tree(store).root_hash()
            check = {
                "commit_index": i,
                "commit_id": commit.id,
                "incremental_hash": incremental_hash,
                "rebuild_hash": rebuild_hash,
                "match": incremental_hash == rebuild_hash,
                "entity_count": len(list(store.find())),
            }
            result["checks"].append(check)

            if incremental_hash != rebuild_hash:
                result["rebuild_failures"].append(
                    {
                        "index": i,
                        "commit_id": commit.id,
                        "incremental_hash": incremental_hash,
                        "rebuild_hash": rebuild_hash,
                    }
                )
                log.error(
                    "Parity check: build != update at commit %d (id=%s): "
                    "incremental=%s rebuild=%s",
                    i,
                    commit.id,
                    incremental_hash,
                    rebuild_hash,
                )

            log.info(
                "Parity check: %d / %d OK (hash=%s, entities=%d)",
                i + 1,
                total,
                incremental_hash,
                check["entity_count"],
            )

    if total >= 100:
        print()  # newline after progress

    result["all_ok"] = (
        not result["stored_hash_failures"]
        and not result["rebuild_failures"]
        and not result["update_errors"]
    )
    return result


# ---------------------------------------------------------------------------
# verify_or_fix_hashes — generator for SSE streaming
# ---------------------------------------------------------------------------


@dataclass
class HashCheckProgress:
    commit_index: int
    total_commits: int
    commit_id: str
    status: Literal["ok", "mismatch_fixed", "mismatch_reported", "removed"]
    computed_hash: str | None = None
    stored_hash: str | None = None
    # Only populated for mismatches — full commit data for diagnostics
    delta_data: dict | None = None
    parent_id: str | None = None
    timestamp: float | None = None
    message: str | None = None


def verify_or_fix_hashes(
    adapter: VcsAdapter,
    branch_name: str = "main",
    fix: bool = False,
) -> Generator[HashCheckProgress, None, None]:
    """Linear replay yielding progress for each commit.

    Compares the incrementally computed hash against the stored
    snapshot_hash. Commits with missing or non-hex stored hashes are
    treated as mismatches.

    If fix=True, writes the corrected snapshot_hash via
    adapter.apply_update() for each mismatched commit.
    """
    graph = adapter.get_commit_graph()
    commit_metas = graph.branch_commits(branch_name)
    commit_ids = [c.id for c in commit_metas]
    commits = adapter.get_commits(commit_ids)
    total = len(commits)

    store = InMemoryStore()
    tree = HashTree()

    for i, commit in enumerate(commits):
        delta = Delta.from_data(commit.delta_data or {})

        # If the delta is effectively empty, remove the commit
        if delta.is_empty():
            if fix:
                # Re-parent the next commit to skip this one
                if i + 1 < len(commits):
                    next_commit = commits[i + 1]
                    next_commit.parent_id = commit.parent_id
                    adapter.apply_update(
                        InternalRepoUpdate(
                            added_commits=[],
                            removed_commits=[
                                CommitMetadata(
                                    id=commit.id,
                                    parent_id=commit.parent_id,
                                    snapshot_hash=commit.snapshot_hash,
                                    timestamp=commit.timestamp,
                                    message=commit.message,
                                )
                            ],
                            updated_commits=[next_commit],
                            added_branches=[],
                            updated_branches=[],
                            removed_branches=[],
                        )
                    )
                else:
                    # Last commit in the chain — remove it and update branch head
                    from sivkit.storage.commit_graph import BranchMetadata

                    adapter.apply_update(
                        InternalRepoUpdate(
                            added_commits=[],
                            removed_commits=[
                                CommitMetadata(
                                    id=commit.id,
                                    parent_id=commit.parent_id,
                                    snapshot_hash=commit.snapshot_hash,
                                    timestamp=commit.timestamp,
                                    message=commit.message,
                                )
                            ],
                            updated_commits=[],
                            added_branches=[],
                            updated_branches=[
                                BranchMetadata(
                                    name=branch_name,
                                    head_commit_id=commit.parent_id or None,
                                )
                            ],
                            removed_branches=[],
                        )
                    )
            yield HashCheckProgress(
                commit_index=i,
                total_commits=total,
                commit_id=commit.id,
                status="removed" if fix else "mismatch_reported",
                stored_hash=commit.snapshot_hash,
                delta_data=commit.delta_data,
                parent_id=commit.parent_id,
                timestamp=commit.timestamp,
                message=commit.message,
            )
            continue

        applied = store.apply_delta(delta)
        update_hash_tree(tree, store, applied)

        computed = tree.root_hash()
        stored = commit.snapshot_hash

        # A stored hash is valid only if it's 64 hex chars
        is_valid = (
            stored
            and len(stored) == 64
            and all(c in "0123456789abcdef" for c in stored)
        )

        if is_valid and computed == stored:
            yield HashCheckProgress(
                commit_index=i,
                total_commits=total,
                commit_id=commit.id,
                status="ok",
                computed_hash=computed,
                stored_hash=stored,
            )
        else:
            # Mismatch or missing/invalid stored hash
            if fix:
                fixed_commit = Commit(
                    id=commit.id,
                    parent_id=commit.parent_id,
                    snapshot_hash=computed,
                    timestamp=commit.timestamp,
                    message=commit.message,
                    delta_data=commit.delta_data,
                )
                adapter.apply_update(
                    InternalRepoUpdate(
                        added_commits=[],
                        removed_commits=[],
                        updated_commits=[fixed_commit],
                        added_branches=[],
                        updated_branches=[],
                        removed_branches=[],
                    )
                )
                yield HashCheckProgress(
                    commit_index=i,
                    total_commits=total,
                    commit_id=commit.id,
                    status="mismatch_fixed",
                    computed_hash=computed,
                    stored_hash=stored,
                    delta_data=commit.delta_data,
                    parent_id=commit.parent_id,
                    timestamp=commit.timestamp,
                    message=commit.message,
                )
            else:
                yield HashCheckProgress(
                    commit_index=i,
                    total_commits=total,
                    commit_id=commit.id,
                    status="mismatch_reported",
                    computed_hash=computed,
                    stored_hash=stored,
                    delta_data=commit.delta_data,
                    parent_id=commit.parent_id,
                    timestamp=commit.timestamp,
                    message=commit.message,
                )
