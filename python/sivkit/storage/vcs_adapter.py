from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any

from sivkit.storage.commit import Commit, CommitMetadata
from sivkit.storage.commit_graph import BranchMetadata, CommitGraph


@dataclass
class InternalRepoUpdate:
    added_commits: list[Commit]
    removed_commits: list[CommitMetadata]
    updated_commits: list[Commit]
    added_branches: list[BranchMetadata]
    updated_branches: list[BranchMetadata]
    removed_branches: list[BranchMetadata]


class VcsAdapter(ABC):
    @abstractmethod
    def get_commit_graph(self) -> CommitGraph: ...

    @abstractmethod
    def get_commits(self, ids: list[str] | None = None) -> list[Commit]:
        """Return commits by IDs, or all commits if ids is None."""
        ...

    @abstractmethod
    def apply_update(self, update: InternalRepoUpdate) -> None: ...

    @abstractmethod
    def close(self) -> None: ...

    @abstractmethod
    def erase_storage(self) -> None: ...
