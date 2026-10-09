"""Tests for Repository with SqliteVcsAdapter (filesystem persistence)."""

import pytest

from sivkit.libs.model import dump_to_dict
from sivkit.storage.delta import Delta
from sivkit.storage.in_memory_store import InMemoryStore
from sivkit.storage.repository import Repository
from sivkit.storage.sqlite_vcs_adapter import SqliteVcsAdapter


@pytest.fixture
def adapter(tmp_path):
    adapter = SqliteVcsAdapter(tmp_path / "vcs.db")
    try:
        yield adapter
    finally:
        adapter.close()


def test_commit_persist_and_reopen(DummyPage, DummyNote, adapter, tmp_path):
    repo = Repository.create(vcs_adapter=adapter)
    aux = InMemoryStore()
    page = DummyPage(id="p1", parent_id="", name="Page 1")
    note = DummyNote(id="n1", parent_id="p1", test_prop="hello")
    changes = [aux.insert_one(page), aux.insert_one(note)]
    commit = repo.commit(Delta.from_changes(changes), "initial")

    adapter.close()
    reopened = SqliteVcsAdapter(tmp_path / "vcs.db")
    try:
        repo2 = Repository.open(vcs_adapter=reopened)
        graph = repo2.get_commit_graph()
        assert [c.id for c in graph.branch_commits("main")] == [commit.id]
        assert {e.id: dump_to_dict(e) for e in repo2.head_store.find()} == {
            page.id: dump_to_dict(page),
            note.id: dump_to_dict(note),
        }
        assert repo2.hash_tree.root_hash() == commit.snapshot_hash
    finally:
        reopened.close()


def test_snapshot_save_and_load(DummyPage, adapter):
    repo = Repository.create(vcs_adapter=adapter)
    aux = InMemoryStore()
    page = DummyPage(id="p1", parent_id="", name="Page 1")
    changes = [aux.insert_one(page)]
    commit = repo.commit(Delta.from_changes(changes), "initial")

    store_data = {e.id: dump_to_dict(e) for e in repo.head_store.find()}
    adapter.save_snapshot(commit.id, store_data)
    assert adapter.load_snapshot(commit.id) == store_data

    adapter.delete_snapshot(commit.id)
    assert adapter.load_snapshot(commit.id) is None
