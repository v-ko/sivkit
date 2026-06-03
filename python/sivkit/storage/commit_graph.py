from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from sivkit.storage.commit import CommitMetadata


@dataclass
class BranchMetadata:
    name: str
    head_commit_id: str | None

    def asdict(self) -> dict[str, Any]:
        return {"name": self.name, "head_commit_id": self.head_commit_id}

    @staticmethod
    def from_dict(data: dict[str, Any]) -> BranchMetadata:
        return BranchMetadata(
            name=data["name"],
            head_commit_id=data.get("head_commit_id"),
        )


@dataclass
class CommitGraphData:
    branches: list[dict[str, Any]]
    commits: list[dict[str, Any]]


class CommitGraph:
    def __init__(self) -> None:
        self._branches: list[BranchMetadata] = []
        self._commits_by_id: dict[str, CommitMetadata] = {}

    @staticmethod
    def from_data(data: CommitGraphData) -> CommitGraph:
        graph = CommitGraph()
        graph._branches = [BranchMetadata.from_dict(b) for b in data.branches]
        for commit_data in data.commits:
            commit = CommitMetadata.from_dict(commit_data)
            graph._commits_by_id[commit.id] = commit
        return graph

    def data(self) -> CommitGraphData:
        return CommitGraphData(
            branches=[deepcopy(b.asdict()) for b in self._branches],
            commits=[c.asdict() for c in self._commits_by_id.values()],
        )

    def create_branch(self, branch_name: str) -> None:
        if any(b.name == branch_name for b in self._branches):
            raise ValueError(f"Branch already exists: {branch_name}")
        self._branches.append(BranchMetadata(name=branch_name, head_commit_id=None))

    def set_branch(self, branch_name: str, head_commit_id: str | None) -> None:
        for b in self._branches:
            if b.name == branch_name:
                b.head_commit_id = head_commit_id
                return
        self._branches.append(
            BranchMetadata(name=branch_name, head_commit_id=head_commit_id)
        )

    def remove_branch(self, branch_name: str) -> None:
        for i, b in enumerate(self._branches):
            if b.name == branch_name:
                self._branches.pop(i)
                return
        raise ValueError(f"Branch not found: {branch_name}")

    def branches(self) -> list[BranchMetadata]:
        return [deepcopy(b) for b in self._branches]

    def branch(self, branch_name: str) -> BranchMetadata | None:
        for b in self._branches:
            if b.name == branch_name:
                return b
        return None

    def head_commit(self, branch_name: str) -> CommitMetadata | None:
        b = self.branch(branch_name)
        if b is None:
            raise ValueError(f"Branch not found: {branch_name}")
        if b.head_commit_id is None:
            return None
        commit = self._commits_by_id.get(b.head_commit_id)
        if commit is None:
            raise ValueError(f"Commit not found: {b.head_commit_id}")
        return commit

    def commits(self) -> list[CommitMetadata]:
        return list(self._commits_by_id.values())

    def commits_between(
        self, start_commit_id: str | None, end_commit_id: str | None
    ) -> list[CommitMetadata]:
        if end_commit_id is not None:
            end_commit = self.commit(end_commit_id)
            if end_commit is None:
                raise ValueError(f"End commit not found: {end_commit_id}")

            commits = [end_commit]
            commit = end_commit
            while commit.parent_id:
                parent = self.commit(commit.parent_id)
                if parent is None:
                    raise ValueError(f"Parent commit not found: {commit.parent_id}")
                if start_commit_id is not None and parent.id == start_commit_id:
                    break
                commits.append(parent)
                commit = parent

            commits.reverse()
            return commits

        elif start_commit_id is not None:
            start_commit = self.commit(start_commit_id)
            if start_commit is None:
                raise ValueError(f"Start commit not found: {start_commit_id}")

            all_commits = self.commits()
            commits = [start_commit]
            commit = start_commit
            while True:
                next_commit = next(
                    (c for c in all_commits if c.parent_id == commit.id), None
                )
                if next_commit is None:
                    break
                commits.append(next_commit)
                commit = next_commit
            return commits

        else:
            raise ValueError("Both start and end commit ids are None")

    def remove_commit(self, commit_id: str) -> None:
        self._commits_by_id.pop(commit_id, None)

    def branch_commits(self, branch_name: str) -> list[CommitMetadata]:
        b = self.branch(branch_name)
        if b is None:
            raise ValueError(f"Branch not found: {branch_name}")
        if b.head_commit_id is None:
            return []

        commit = self.commit(b.head_commit_id)
        if commit is None:
            raise ValueError(f"Head commit not found: {b.head_commit_id}")

        commits = [commit]
        while commit.parent_id:
            commit = self.commit(commit.parent_id)
            if commit is None:
                raise ValueError("Parent commit not found")
            commits.append(commit)

        commits.reverse()
        return commits

    def add_commit(self, commit: CommitMetadata) -> None:
        # Store a copy
        commit = CommitMetadata.from_dict(commit.asdict())
        self._commits_by_id[commit.id] = commit

    def commit(self, commit_id: str) -> CommitMetadata | None:
        return self._commits_by_id.get(commit_id)

    def clear(self) -> None:
        self._branches.clear()
        self._commits_by_id.clear()
