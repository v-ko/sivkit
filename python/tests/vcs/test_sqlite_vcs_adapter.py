"""Tests for Repository with SqliteVcsAdapter (filesystem persistence)."""

import shutil
import tempfile
from pathlib import Path

from sivkit.libs.model import dump_to_dict
from sivkit.storage.delta import Delta
from sivkit.storage.in_memory_store import InMemoryStore
from sivkit.storage.repository import Repository
from sivkit.storage.sqlite_vcs_adapter import SqliteVcsAdapter


def test_commit_persist_and_reopen(DummyPage, DummyNote):
    tmp = tempfile.mkdtemp()
    try:
        adapter = SqliteVcsAdapter(Path(tmp) / "vcs.db")
        repo = Repository.create(vcs_adapter=adapter)

        aux = InMemoryStore()
        page = DummyPage(id="p1", parent_id="", name="Page 1")
        note = DummyNote(id="n1", parent_id="p1", test_prop="hello")
        changes = [aux.insert_one(page), aux.insert_one(note)]
        commit = repo.commit(Delta.from_changes(changes), "initial")

        # Reopen from disk
        adapter.close()
        adapter2 = SqliteVcsAdapter(Path(tmp) / "vcs.db")
        repo2 = Repository.open(vcs_adapter=adapter2)

        graph = repo2.get_commit_graph()
        assert len(graph.branch_commits("main")) == 1

        found = repo2.head_store.find_one(id="p1")
        assert found is not None
        assert found.name == "Page 1"

        assert repo2.hash_tree.root_hash() == commit.snapshot_hash
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_snapshot_save_and_load(DummyPage):
    tmp = tempfile.mkdtemp()
    try:
        adapter = SqliteVcsAdapter(Path(tmp) / "vcs.db")
        repo = Repository.create(vcs_adapter=adapter)

        aux = InMemoryStore()
        page = DummyPage(id="p1", parent_id="", name="Page 1")
        changes = [aux.insert_one(page)]
        commit = repo.commit(Delta.from_changes(changes), "initial")

        # Save snapshot of current head store
        store_data = {e.id: dump_to_dict(e) for e in repo.head_store.find()}
        adapter.save_snapshot(commit.id, store_data)

        # Verify it persists
        loaded = adapter.load_snapshot(commit.id)
        assert "p1" in loaded
        assert loaded["p1"]["name"] == "Page 1"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
