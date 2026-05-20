"""SQLite-backed VCS adapter with snapshot support (via peewee)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import peewee as pw

from fusion import get_logger
from fusion.storage.commit import Commit, CommitMetadata
from fusion.storage.commit_graph import BranchMetadata, CommitGraph, CommitGraphData
from fusion.storage.vcs_adapter import InternalRepoUpdate, VcsAdapter

log = get_logger(__name__)

_ALL_MODELS: list[type[pw.Model]] = []


class CommitRow(pw.Model):
    id: str = pw.TextField(primary_key=True)  # type: ignore[assignment]
    parent_id: str = pw.TextField(default="")  # type: ignore[assignment]
    snapshot_hash: str = pw.TextField(default="")  # type: ignore[assignment]
    timestamp: float = pw.DoubleField(default=0)  # type: ignore[assignment]
    message: str = pw.TextField(default="")  # type: ignore[assignment]
    delta_data: str = pw.TextField(default="{}")  # type: ignore[assignment]


class SnapshotRow(pw.Model):
    commit_id: str = pw.TextField(primary_key=True)  # type: ignore[assignment]
    data: str = pw.TextField()  # type: ignore[assignment]


class BranchRow(pw.Model):
    name: str = pw.TextField(primary_key=True)  # type: ignore[assignment]
    head_commit_id: str | None = pw.TextField(null=True)  # type: ignore[assignment]


_ALL_MODELS = [CommitRow, SnapshotRow, BranchRow]


class SqliteVcsAdapter(VcsAdapter):

    def __init__(self, db_path: Path) -> None:
        self._db_path = Path(db_path)
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._db = pw.SqliteDatabase(
            str(self._db_path), pragmas={"journal_mode": "wal"}
        )
        self._db.connect()
        with self._db.bind_ctx(_ALL_MODELS):
            self._db.create_tables(_ALL_MODELS)

    def _ctx(self):
        return self._db.bind_ctx(_ALL_MODELS)

    # ------------------------------------------------------------------
    # VcsAdapter interface
    # ------------------------------------------------------------------

    def get_commit_graph(self) -> CommitGraph:
        graph = CommitGraph()
        with self._ctx():
            for row in BranchRow.select():
                try:
                    graph.create_branch(row.name)
                except ValueError:
                    pass
                if row.head_commit_id:
                    graph.set_branch(row.name, row.head_commit_id)

            for row in CommitRow.select(
                CommitRow.id,
                CommitRow.parent_id,
                CommitRow.snapshot_hash,
                CommitRow.timestamp,
                CommitRow.message,
            ):
                meta = CommitMetadata(
                    id=row.id,
                    parent_id=row.parent_id,
                    snapshot_hash=row.snapshot_hash,
                    timestamp=row.timestamp,
                    message=row.message,
                )
                graph.add_commit(meta)

        return graph

    def get_commits(self, ids: list[str] | None = None) -> list[Commit]:
        result: list[Commit] = []
        with self._ctx():
            if ids is None:
                # Full table scan — return all commits (used by hydration)
                for row in CommitRow.select():
                    result.append(self._row_to_commit(row))
            else:
                # Batch fetch by IDs in chunks to stay within SQLite variable limits
                CHUNK_SIZE = 500
                # Build an id→position map to preserve requested order
                id_to_pos = {cid: i for i, cid in enumerate(ids)}
                result = [None] * len(ids)  # type: ignore[list-item]
                for start in range(0, len(ids), CHUNK_SIZE):
                    chunk = ids[start : start + CHUNK_SIZE]
                    for row in CommitRow.select().where(
                        CommitRow.id << chunk
                    ):  # type: ignore[operator]  # peewee Field.__lshift__ → SQL IN
                        pos = id_to_pos[row.id]
                        result[pos] = self._row_to_commit(row)
                # Check for missing commits
                for i, commit in enumerate(result):
                    if commit is None:
                        raise ValueError(f"Commit {ids[i]} not found")
        return result

    def apply_update(self, update: InternalRepoUpdate) -> None:
        with self._ctx(), self._db.atomic():
            for meta in update.removed_commits:
                CommitRow.delete_by_id(meta.id)

            for commit in update.updated_commits:
                self._upsert_commit(commit)

            for commit in update.added_commits:
                self._upsert_commit(commit)

            for branch in update.added_branches:
                BranchRow.replace(
                    name=branch.name,
                    head_commit_id=branch.head_commit_id,
                ).execute()

            for branch in update.updated_branches:
                BranchRow.replace(
                    name=branch.name,
                    head_commit_id=branch.head_commit_id,
                ).execute()

            for branch in update.removed_branches:
                BranchRow.delete().where(BranchRow.name == branch.name).execute()

    def close(self) -> None:
        if not self._db.is_closed():
            self._db.close()

    def erase_storage(self) -> None:
        with self._ctx(), self._db.atomic():
            SnapshotRow.delete().execute()
            CommitRow.delete().execute()
            BranchRow.delete().execute()

    # ------------------------------------------------------------------
    # Snapshot support
    # ------------------------------------------------------------------

    def save_snapshot(self, commit_id: str, store_data: dict[str, Any]) -> None:
        with self._ctx():
            SnapshotRow.replace(
                commit_id=commit_id,
                data=json.dumps(store_data),
            ).execute()

    def load_snapshot(self, commit_id: str) -> dict[str, Any] | None:
        with self._ctx():
            row = SnapshotRow.get_or_none(SnapshotRow.commit_id == commit_id)
        if row is None:
            return None
        return json.loads(row.data)

    def snapshot_commit_ids(self) -> list[str]:
        with self._ctx():
            return [row.commit_id for row in SnapshotRow.select(SnapshotRow.commit_id)]

    def has_snapshot(self, commit_id: str) -> bool:
        with self._ctx():
            return (
                SnapshotRow.select().where(SnapshotRow.commit_id == commit_id).exists()
            )

    # ------------------------------------------------------------------
    # Chain walking
    # ------------------------------------------------------------------

    def walk_chain(self, start_id: str) -> list[str]:
        """Walk the commit chain from start_id following parent_id links.

        Returns [start_id, parent_of_start, grandparent, ..., root].
        """
        chain: list[str] = []
        current = start_id
        seen: set[str] = set()
        with self._ctx():
            while current:
                if current in seen:
                    log.warning("Cycle detected at commit %s", current)
                    break
                seen.add(current)
                row = CommitRow.get_or_none(CommitRow.id == current)
                if row is None:
                    break
                chain.append(current)
                current = row.parent_id
        return chain

    def find_latest_snapshot_commit(self, head_id: str) -> str | None:
        """Walk backward from head_id, return first commit with a snapshot."""
        for commit_id in self.walk_chain(head_id):
            if self.has_snapshot(commit_id):
                return commit_id
        return None

    # ------------------------------------------------------------------
    # Direct commit write (used by backward pipeline)
    # ------------------------------------------------------------------

    def write_commit(self, commit: Commit) -> None:
        """Write a single commit to the DB."""
        with self._ctx():
            self._upsert_commit(commit)

    def update_commit_field(self, commit_id: str, **fields: Any) -> None:
        """Update specific fields on an existing commit."""
        with self._ctx():
            CommitRow.update(**fields).where(CommitRow.id == commit_id).execute()

    def get_commit(self, commit_id: str) -> Commit | None:
        """Get a single commit by ID, or None."""
        with self._ctx():
            row = CommitRow.get_or_none(CommitRow.id == commit_id)
        if row is None:
            return None
        return self._row_to_commit(row)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _row_to_commit(row: CommitRow) -> Commit:
        return Commit(
            id=row.id,  # type: ignore
            parent_id=row.parent_id,  # type: ignore
            snapshot_hash=row.snapshot_hash,  # type: ignore
            timestamp=row.timestamp,  # type: ignore
            message=row.message,  # type: ignore
            delta_data=json.loads(row.delta_data) if row.delta_data else {},  # type: ignore
        )

    @staticmethod
    def _upsert_commit(commit: Commit) -> None:
        CommitRow.replace(
            id=commit.id,
            parent_id=commit.parent_id,
            snapshot_hash=commit.snapshot_hash,
            timestamp=commit.timestamp,
            message=commit.message,
            delta_data=json.dumps(commit.delta_data),
        ).execute()
