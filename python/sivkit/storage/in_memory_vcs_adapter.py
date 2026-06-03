from __future__ import annotations

import logging

from sivkit.storage.commit import Commit
from sivkit.storage.commit_graph import CommitGraph
from sivkit.storage.vcs_adapter import InternalRepoUpdate, VcsAdapter

log = logging.getLogger(__name__)


class InMemoryVcsAdapter(VcsAdapter):
    def __init__(self) -> None:
        self._commit_graph = CommitGraph()
        self._commit_by_id: dict[str, Commit] = {}

    def get_commit_graph(self) -> CommitGraph:
        return CommitGraph.from_data(self._commit_graph.data())

    def get_commits(self, ids: list[str] | None = None) -> list[Commit]:
        if ids is None:
            return list(self._commit_by_id.values())
        result: list[Commit] = []
        for commit_id in ids:
            commit = self._commit_by_id.get(commit_id)
            if commit is None:
                raise ValueError(f"Commit {commit_id} not found")
            result.append(commit)
        return result

    def apply_update(self, update: InternalRepoUpdate) -> None:
        # Remove old commits
        for commit in update.removed_commits:
            self._commit_by_id.pop(commit.id, None)
            self._commit_graph.remove_commit(commit.id)

        # Update existing commits (full replace: metadata + delta)
        for commit in update.updated_commits:
            self._commit_by_id.pop(commit.id, None)
            self._commit_by_id[commit.id] = commit
            self._commit_graph.remove_commit(commit.id)
            self._commit_graph.add_commit(commit.metadata())

        # Add new commits
        for commit in update.added_commits:
            self._commit_by_id[commit.id] = commit
            self._commit_graph.add_commit(commit.metadata())

        # Add new branches
        for branch in update.added_branches:
            self._commit_graph.create_branch(branch.name)
            if branch.head_commit_id:
                self._commit_graph.set_branch(branch.name, branch.head_commit_id)

        # Update branches
        for branch in update.updated_branches:
            self._commit_graph.set_branch(branch.name, branch.head_commit_id)

        # Remove branches
        for branch in update.removed_branches:
            self._commit_graph.remove_branch(branch.name)

    def close(self) -> None:
        pass

    def erase_storage(self) -> None:
        self._commit_graph = CommitGraph()
        self._commit_by_id.clear()
