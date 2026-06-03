from __future__ import annotations

from sivkit import get_logger
from sivkit.libs.model import Entity
from sivkit.storage.commit import Commit
from sivkit.storage.commit_graph import BranchMetadata, CommitGraph
from sivkit.storage.delta import Delta, squash_deltas
from sivkit.storage.hash_tree import (
    HangingSubtreesError,
    HashTree,
    build_hash_tree,
    update_hash_tree,
)
from sivkit.storage.in_memory_store import InMemoryStore
from sivkit.storage.in_memory_vcs_adapter import InMemoryVcsAdapter
from sivkit.storage.vcs_adapter import InternalRepoUpdate, VcsAdapter
from sivkit.util import get_new_id

log = get_logger(__name__)


class RepositoryIntegrityError(Exception):
    pass


class MissingBranchError(Exception):
    pass


class EmptyRepositoryError(Exception):
    """Raised when opening a repository that has no branches/commits."""

    pass


class Repository:
    """Python port of the TS Repository.

    Always uses caching (head store + hash tree). The VcsAdapter is the
    persistence backend (InMemoryVcsAdapter by default).
    """

    def __init__(
        self,
        vcs_adapter: VcsAdapter | None = None,
        branch_name: str = "main",
    ) -> None:
        self._vcs_adapter: VcsAdapter = vcs_adapter or InMemoryVcsAdapter()
        self._current_branch = branch_name

        self._head_store = InMemoryStore()
        self._commit_graph = CommitGraph()
        self._commit_by_id: dict[str, Commit] = {}
        self._hash_tree: HashTree | None = None

    # ------------------------------------------------------------------
    # Factory methods
    # ------------------------------------------------------------------

    @staticmethod
    def create(
        vcs_adapter: VcsAdapter | None = None,
        branch_name: str = "main",
    ) -> Repository:
        """Create a fresh repository with an empty branch."""
        repo = Repository(vcs_adapter, branch_name)
        repo._commit_graph.create_branch(branch_name)
        repo._hash_tree = build_hash_tree(repo._head_store)

        # Persist initial branch
        repo._vcs_adapter.apply_update(
            InternalRepoUpdate(
                added_commits=[],
                removed_commits=[],
                updated_commits=[],
                added_branches=[BranchMetadata(name=branch_name, head_commit_id=None)],
                updated_branches=[],
                removed_branches=[],
            )
        )
        return repo

    @staticmethod
    def open(
        vcs_adapter: VcsAdapter,
        branch_name: str = "main",
        head_store_data: list[Entity] | None = None,
    ) -> Repository:
        """Open an existing repository, hydrating from the VcsAdapter."""
        repo = Repository(vcs_adapter, branch_name)

        commit_graph = repo._vcs_adapter.get_commit_graph()

        if not commit_graph.branches():
            raise EmptyRepositoryError(
                "Repository has no branches — it may not have been created yet."
            )

        branch = commit_graph.branch(branch_name)
        if branch is None:
            all_branches = commit_graph.branches()
            raise MissingBranchError(
                f'Branch "{branch_name}" not found. '
                f"Branches: {[b.name for b in all_branches]}"
            )

        if head_store_data:
            for entity in head_store_data:
                repo._head_store.insert_one(entity)
            repo._hash_tree = build_hash_tree(repo._head_store)
        else:
            repo._hash_tree = build_hash_tree(repo._head_store)
            repo._hydrate_from_adapter(commit_graph)

        return repo

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @property
    def head_store(self) -> InMemoryStore:
        return self._head_store

    @property
    def hash_tree(self) -> HashTree:
        if self._hash_tree is None:
            raise RuntimeError("Hash tree is not initialized")
        return self._hash_tree

    @property
    def current_branch(self) -> str:
        return self._current_branch

    def get_commit_graph(self) -> CommitGraph:
        return CommitGraph.from_data(self._commit_graph.data())

    def get_commits(self, ids: list[str]) -> list[Commit]:
        result: list[Commit] = []
        for commit_id in ids:
            commit = self._commit_by_id.get(commit_id)
            if commit is None:
                raise ValueError(f"Commit {commit_id} not found in cache")
            result.append(commit)
        return result

    def commit(
        self,
        delta: Delta,
        message: str = "",
        timestamp: float | None = None,
    ) -> Commit:
        """Create a commit from a delta.

        The delta is applied to the head store and a Commit object is produced
        and persisted through the VcsAdapter.

        Args:
            delta: The delta to commit.
            message: Commit message.
            timestamp: Epoch milliseconds. If None, uses current time.
        """
        import time

        if timestamp is None:
            timestamp = time.time() * 1000

        if delta.is_empty():
            raise ValueError("Cannot commit an empty delta")

        # Apply to the head store
        applied_delta = self._head_store.apply_delta(delta)

        # Update hash tree
        try:
            update_hash_tree(self.hash_tree, self._head_store, applied_delta)
        except HangingSubtreesError as e:
            # Revert store state
            self._head_store.apply_delta(applied_delta.reversed())
            raise RuntimeError(
                "Error updating hash tree. Are you committing entities whose "
                f"parents are not in the store? {e}"
            ) from e
        except Exception as e:
            self._head_store.apply_delta(applied_delta.reversed())
            raise RuntimeError(f"Error updating hash tree: {e}") from e

        snapshot_hash = self.hash_tree.root_hash()

        # Determine parent
        commits = self._commit_graph.branch_commits(self._current_branch)
        parent_id = commits[-1].id if commits else ""

        commit = Commit(
            id=get_new_id(),
            parent_id=parent_id,
            snapshot_hash=snapshot_hash,
            delta_data=applied_delta.asdict(),
            message=message,
            timestamp=timestamp,
        )

        # Update graph + cache
        self._commit_graph.add_commit(commit.metadata())
        self._commit_by_id[commit.id] = commit
        self._commit_graph.set_branch(self._current_branch, commit.id)

        branch = self._commit_graph.branch(self._current_branch)
        assert branch is not None

        self._vcs_adapter.apply_update(
            InternalRepoUpdate(
                added_commits=[commit],
                removed_commits=[],
                updated_commits=[],
                added_branches=[],
                updated_branches=[branch],
                removed_branches=[],
            )
        )

        return commit

    def reset(self, relative_to_head: int) -> None:
        """Reset the current branch back by *relative_to_head* commits (negative number)."""
        if relative_to_head == 0:
            return
        if relative_to_head > 0:
            raise ValueError("Reset forward not supported")

        head_commit = self._commit_graph.head_commit(self._current_branch)
        if head_commit is None:
            raise ValueError("No head commit found")

        branch_commits = self._commit_graph.branch_commits(self._current_branch)
        head_index = next(
            i for i, c in enumerate(branch_commits) if c.id == head_commit.id
        )

        target_index = head_index + relative_to_head
        if target_index < 0:
            raise ValueError("Resetting too far back")

        target_commit = branch_commits[target_index]

        # Revert by applying reversed deltas of commits being removed
        commits_to_revert = branch_commits[target_index + 1 :]
        commits_to_revert_full = self.get_commits([c.id for c in commits_to_revert])
        reversed_deltas = [
            Delta.from_data(c.delta_data).reversed().asdict()
            for c in commits_to_revert_full
        ]
        squashed_delta = squash_deltas(reversed_deltas)
        self._head_store.apply_delta(squashed_delta)

        # Remove from graph + cache
        for c in commits_to_revert:
            self._commit_by_id.pop(c.id, None)
            self._commit_graph.remove_commit(c.id)

        # Update hash tree
        update_hash_tree(self.hash_tree, self._head_store, squashed_delta)
        self._commit_graph.set_branch(self._current_branch, target_commit.id)

        # Integrity check
        snapshot_hash = self.hash_tree.root_hash()
        if snapshot_hash != target_commit.snapshot_hash:
            raise RepositoryIntegrityError("Snapshot hash mismatch after reset")

        branch = self._commit_graph.branch(self._current_branch)
        assert branch is not None
        self._vcs_adapter.apply_update(
            InternalRepoUpdate(
                added_commits=[],
                removed_commits=commits_to_revert,
                updated_commits=[],
                added_branches=[],
                updated_branches=[branch],
                removed_branches=[],
            )
        )

    def close(self) -> None:
        self._vcs_adapter.close()

    def erase_storage(self) -> None:
        self._vcs_adapter.erase_storage()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _hydrate_from_adapter(self, commit_graph: CommitGraph | None = None) -> None:
        """Replay all commits from the VcsAdapter onto the head store."""
        remote_graph = commit_graph or self._vcs_adapter.get_commit_graph()

        # Get branch commits in order
        branch = remote_graph.branch(self._current_branch)
        if branch is None or branch.head_commit_id is None:
            # Empty branch, nothing to hydrate
            self._commit_graph = remote_graph
            return

        branch_commits_meta = remote_graph.branch_commits(self._current_branch)
        commit_ids = [c.id for c in branch_commits_meta]
        commits = self._vcs_adapter.get_commits(commit_ids)

        # Replay deltas in order
        for commit_obj in commits:
            delta = Delta.from_data(commit_obj.delta_data)
            self._head_store.apply_delta(delta)
            self._commit_by_id[commit_obj.id] = commit_obj

        # Update hash tree for the final state
        self._hash_tree = build_hash_tree(self._head_store)

        # Verify integrity
        last_commit = commits[-1] if commits else None
        if last_commit and last_commit.snapshot_hash:
            snapshot_hash = self._hash_tree.root_hash()
            if snapshot_hash != last_commit.snapshot_hash:
                entity_count = len(list(self._head_store.find()))
                msg = (
                    f"Snapshot hash mismatch after hydration: "
                    f"computed={snapshot_hash[:16]}..., "
                    f"stored={last_commit.snapshot_hash[:16]}..., "
                    f"commit_id={last_commit.id}, "
                    f"entity_count={entity_count}"
                )
                log.error(msg)
                raise RepositoryIntegrityError(msg)

        self._commit_graph = remote_graph
