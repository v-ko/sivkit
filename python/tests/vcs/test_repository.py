"""Tests for Repository."""

from sivkit.libs.model import dump_to_dict
from sivkit.storage.delta import Delta
from sivkit.storage.hash_tree import build_hash_tree
from sivkit.storage.in_memory_store import InMemoryStore
from sivkit.storage.repository import Repository


def test_commit_and_hash_integrity(DummyPage, DummyNote):
    repo = Repository.create()
    initial_hash = repo.hash_tree.root_hash()

    # Build a delta outside the repo
    aux_store = InMemoryStore()
    changes = [
        aux_store.insert_one(DummyPage(id="page1", parent_id="", name="Page 1")),
        aux_store.insert_one(DummyNote(id="note1", parent_id="page1", test_prop="e1")),
    ]
    delta = Delta.from_changes(changes)

    commit = repo.commit(delta, "Initial commit")
    hash_after = repo.hash_tree.root_hash()

    assert commit.snapshot_hash == hash_after
    assert hash_after != initial_hash
    assert {e.id: dump_to_dict(e) for e in repo.head_store.find()} == {
        e.id: dump_to_dict(e) for e in aux_store.find()
    }

    # Reverse commit restores hash
    reverse_delta = delta.reversed()
    reverse_commit = repo.commit(reverse_delta, "Reverse commit")
    assert reverse_commit.snapshot_hash == repo.hash_tree.root_hash()
    assert repo.hash_tree.root_hash() == initial_hash
    assert list(repo.head_store.find()) == []


def test_commit_graph_tracks_commits(DummyPage, DummyNote):
    repo = Repository.create()

    aux = InMemoryStore()
    changes = [
        aux.insert_one(DummyPage(id="p1", parent_id="", name="P1")),
    ]
    repo.commit(Delta.from_changes(changes), "first")
    repo.commit(
        Delta.from_changes(
            [aux.insert_one(DummyNote(id="n1", parent_id="p1", test_prop="x"))]
        ),
        "second",
    )

    graph = repo.get_commit_graph()
    branch_commits = graph.branch_commits("main")
    assert len(branch_commits) == 2


def test_reset(DummyPage, DummyNote):
    repo = Repository.create()

    aux = InMemoryStore()
    c1_delta = Delta.from_changes(
        [
            aux.insert_one(DummyPage(id="p1", parent_id="", name="P1")),
        ]
    )
    repo.commit(c1_delta, "first")
    hash_after_c1 = repo.hash_tree.root_hash()

    c2_delta = Delta.from_changes(
        [
            aux.insert_one(DummyNote(id="n1", parent_id="p1", test_prop="x")),
        ]
    )
    repo.commit(c2_delta, "second")

    # Reset back one commit
    repo.reset(-1)

    assert repo.hash_tree.root_hash() == hash_after_c1
    assert [dump_to_dict(e) for e in repo.head_store.find()] == [
        dump_to_dict(DummyPage(id="p1", parent_id="", name="P1"))
    ]
    graph = repo.get_commit_graph()
    assert len(graph.branch_commits("main")) == 1


def test_remove_page_with_child_and_verify(DummyPage, DummyNote):
    repo = Repository.create()

    aux = InMemoryStore()
    changes = [
        aux.insert_one(DummyPage(id="page1", parent_id="", name="P1")),
        aux.insert_one(DummyNote(id="note1", parent_id="page1", test_prop="n1")),
        aux.insert_one(DummyPage(id="page2", parent_id="", name="P2")),
        aux.insert_one(DummyNote(id="note2", parent_id="page2", test_prop="n2")),
    ]
    repo.commit(Delta.from_changes(changes), "initial")

    # Remove page1 and its note
    page1 = aux.find_one(id="page1")
    note1 = aux.find_one(id="note1")
    assert page1 is not None and note1 is not None
    remove_changes = [
        aux.remove_one(note1),
        aux.remove_one(page1),
    ]
    commit = repo.commit(Delta.from_changes(remove_changes), "remove page1")
    assert {e.id: dump_to_dict(e) for e in repo.head_store.find()} == {
        "page2": dump_to_dict(DummyPage(id="page2", parent_id="", name="P2")),
        "note2": dump_to_dict(DummyNote(id="note2", parent_id="page2", test_prop="n2")),
    }

    # Rebuild hash tree from scratch and compare
    rebuilt = build_hash_tree(repo.head_store)
    assert rebuilt.root_hash() == commit.snapshot_hash


def test_head_store_reflects_commits(DummyPage):
    repo = Repository.create()

    aux = InMemoryStore()
    page = DummyPage(id="p1", parent_id="", name="My Page")
    changes = [aux.insert_one(page)]
    repo.commit(Delta.from_changes(changes), "add page")

    found = repo.head_store.find_one(id="p1")
    assert found is not None
    assert found.name == "My Page"
