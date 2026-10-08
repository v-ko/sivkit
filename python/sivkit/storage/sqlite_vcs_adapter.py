"""SQLite-backed VCS adapter with snapshot support (via SQLAlchemy)."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from sqlalchemy import Float, Insert, Text, delete, exists, insert, select, update
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

from sivkit.storage.commit import Commit, CommitMetadata
from sivkit.storage.commit_graph import BranchMetadata, CommitGraph, CommitGraphData
from sivkit.storage.sqlite_engine import create_sqlite_engine
from sivkit.storage.vcs_adapter import InternalRepoUpdate, VcsAdapter

log = logging.getLogger(__name__)


class _Base(DeclarativeBase):
    pass


# Table names match the ones peewee created, so existing databases open as is.
class CommitRow(_Base):
    __tablename__ = "commitrow"
    id: Mapped[str] = mapped_column(Text, primary_key=True)
    parent_id: Mapped[str] = mapped_column(Text, default="")
    snapshot_hash: Mapped[str] = mapped_column(Text, default="")
    timestamp: Mapped[float] = mapped_column(Float, default=0)
    message: Mapped[str] = mapped_column(Text, default="")
    delta_data: Mapped[str] = mapped_column(Text, default="{}")


class SnapshotRow(_Base):
    __tablename__ = "snapshotrow"
    commit_id: Mapped[str] = mapped_column(Text, primary_key=True)
    data: Mapped[str] = mapped_column(Text)


class BranchRow(_Base):
    __tablename__ = "branchrow"
    name: Mapped[str] = mapped_column(Text, primary_key=True)
    head_commit_id: Mapped[str | None] = mapped_column(Text)


def _replace(model: type[_Base], **values: Any) -> Insert:
    # INSERT OR REPLACE (not an upsert): the row gets a new rowid, as with peewee.
    return insert(model).prefix_with("OR REPLACE").values(**values)


class SqliteVcsAdapter(VcsAdapter):

    def __init__(self, db_path: Path) -> None:
        self._db_path = Path(db_path)
        self._engine = create_sqlite_engine(self._db_path)
        _Base.metadata.create_all(self._engine)
        self._session = sessionmaker(self._engine)

    # ------------------------------------------------------------------
    # VcsAdapter interface
    # ------------------------------------------------------------------

    def get_commit_graph(self) -> CommitGraph:
        graph = CommitGraph()
        with self._session() as s:
            for name, head_commit_id in s.execute(
                select(BranchRow.name, BranchRow.head_commit_id)
            ):
                try:
                    graph.create_branch(name)
                except ValueError:
                    pass
                if head_commit_id:
                    graph.set_branch(name, head_commit_id)

            for row in s.execute(
                select(
                    CommitRow.id,
                    CommitRow.parent_id,
                    CommitRow.snapshot_hash,
                    CommitRow.timestamp,
                    CommitRow.message,
                )
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
        with self._session() as s:
            if ids is None:
                # Full table scan — return all commits (used by hydration)
                return [
                    self._row_to_commit(row) for row in s.scalars(select(CommitRow))
                ]

            # Batch fetch by IDs in chunks to stay within SQLite variable limits
            CHUNK_SIZE = 500
            # Build an id→position map to preserve requested order
            id_to_pos = {cid: i for i, cid in enumerate(ids)}
            result: list[Commit | None] = [None] * len(ids)
            for start in range(0, len(ids), CHUNK_SIZE):
                chunk = ids[start : start + CHUNK_SIZE]
                for row in s.scalars(select(CommitRow).where(CommitRow.id.in_(chunk))):
                    result[id_to_pos[row.id]] = self._row_to_commit(row)
        # Check for missing commits
        for i, commit in enumerate(result):
            if commit is None:
                raise ValueError(f"Commit {ids[i]} not found")
        return result  # type: ignore[return-value]

    def apply_update(self, update: InternalRepoUpdate) -> None:
        with self._session.begin() as s:
            for meta in update.removed_commits:
                s.execute(delete(CommitRow).where(CommitRow.id == meta.id))

            for commit in update.updated_commits:
                s.execute(self._replace_commit(commit))

            for commit in update.added_commits:
                s.execute(self._replace_commit(commit))

            for branch in update.added_branches:
                s.execute(
                    _replace(
                        BranchRow,
                        name=branch.name,
                        head_commit_id=branch.head_commit_id,
                    )
                )

            for branch in update.updated_branches:
                s.execute(
                    _replace(
                        BranchRow,
                        name=branch.name,
                        head_commit_id=branch.head_commit_id,
                    )
                )

            for branch in update.removed_branches:
                s.execute(delete(BranchRow).where(BranchRow.name == branch.name))

    def close(self) -> None:
        self._engine.dispose()

    def erase_storage(self) -> None:
        with self._session.begin() as s:
            s.execute(delete(SnapshotRow))
            s.execute(delete(CommitRow))
            s.execute(delete(BranchRow))

    # ------------------------------------------------------------------
    # Snapshot support
    # ------------------------------------------------------------------

    def save_snapshot(self, commit_id: str, store_data: dict[str, Any]) -> None:
        with self._session.begin() as s:
            s.execute(
                _replace(SnapshotRow, commit_id=commit_id, data=json.dumps(store_data))
            )

    def load_snapshot(self, commit_id: str) -> dict[str, Any] | None:
        with self._session() as s:
            data = s.scalar(
                select(SnapshotRow.data).where(SnapshotRow.commit_id == commit_id)
            )
        if data is None:
            return None
        return json.loads(data)

    def delete_snapshot(self, commit_id: str) -> None:
        with self._session.begin() as s:
            s.execute(delete(SnapshotRow).where(SnapshotRow.commit_id == commit_id))

    def snapshot_commit_ids(self) -> list[str]:
        with self._session() as s:
            return list(s.scalars(select(SnapshotRow.commit_id)))

    def has_snapshot(self, commit_id: str) -> bool:
        with self._session() as s:
            return bool(
                s.scalar(select(exists().where(SnapshotRow.commit_id == commit_id)))
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
        with self._session() as s:
            while current:
                if current in seen:
                    log.warning("Cycle detected at commit %s", current)
                    break
                seen.add(current)
                parent_id = s.scalar(
                    select(CommitRow.parent_id).where(CommitRow.id == current)
                )
                if parent_id is None:
                    break
                chain.append(current)
                current = parent_id
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
        with self._session.begin() as s:
            s.execute(self._replace_commit(commit))

    def update_commit_field(self, commit_id: str, **fields: Any) -> None:
        """Update specific fields on an existing commit."""
        with self._session.begin() as s:
            s.execute(
                update(CommitRow).where(CommitRow.id == commit_id).values(**fields)
            )

    def get_commit(self, commit_id: str) -> Commit | None:
        """Get a single commit by ID, or None."""
        with self._session() as s:
            row = s.get(CommitRow, commit_id)
            if row is None:
                return None
            return self._row_to_commit(row)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _row_to_commit(row: CommitRow) -> Commit:
        return Commit(
            id=row.id,
            parent_id=row.parent_id,
            snapshot_hash=row.snapshot_hash,
            timestamp=row.timestamp,
            message=row.message,
            delta_data=json.loads(row.delta_data) if row.delta_data else {},
        )

    @staticmethod
    def _replace_commit(commit: Commit) -> Insert:
        return _replace(
            CommitRow,
            id=commit.id,
            parent_id=commit.parent_id,
            snapshot_hash=commit.snapshot_hash,
            timestamp=commit.timestamp,
            message=commit.message,
            delta_data=json.dumps(commit.delta_data),
        )
