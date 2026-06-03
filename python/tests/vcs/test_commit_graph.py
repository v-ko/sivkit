"""Tests for CommitGraph."""

from sivkit.storage.commit import CommitMetadata
from sivkit.storage.commit_graph import CommitGraph


def test_create_and_query_branch():
    g = CommitGraph()
    g.create_branch("main")
    assert g.branch("main") is not None
    assert g.branch("main").head_commit_id is None


def test_add_commit_and_head():
    g = CommitGraph()
    g.create_branch("main")
    cm = CommitMetadata(
        id="c1", parent_id="", snapshot_hash="h1", timestamp=1.0, message="init"
    )
    g.add_commit(cm)
    g.set_branch("main", "c1")
    head = g.head_commit("main")
    assert head is not None
    assert head.id == "c1"


def test_branch_commits_order():
    g = CommitGraph()
    g.create_branch("main")
    c1 = CommitMetadata(
        id="c1", parent_id="", snapshot_hash="h1", timestamp=1.0, message="first"
    )
    c2 = CommitMetadata(
        id="c2", parent_id="c1", snapshot_hash="h2", timestamp=2.0, message="second"
    )
    c3 = CommitMetadata(
        id="c3", parent_id="c2", snapshot_hash="h3", timestamp=3.0, message="third"
    )
    g.add_commit(c1)
    g.add_commit(c2)
    g.add_commit(c3)
    g.set_branch("main", "c3")

    branch_commits = g.branch_commits("main")
    assert [c.id for c in branch_commits] == ["c1", "c2", "c3"]


def test_serialization_roundtrip():
    g = CommitGraph()
    g.create_branch("main")
    cm = CommitMetadata(
        id="c1", parent_id="", snapshot_hash="h1", timestamp=1.0, message="init"
    )
    g.add_commit(cm)
    g.set_branch("main", "c1")

    data = g.data()
    g2 = CommitGraph.from_data(data)
    assert g2.branch("main").head_commit_id == "c1"
    assert g2.commit("c1").message == "init"


def test_remove_branch():
    g = CommitGraph()
    g.create_branch("main")
    g.remove_branch("main")
    assert g.branch("main") is None


def test_commits_between():
    g = CommitGraph()
    g.create_branch("main")
    for i in range(1, 6):
        parent = f"c{i-1}" if i > 1 else ""
        g.add_commit(
            CommitMetadata(
                id=f"c{i}",
                parent_id=parent,
                snapshot_hash=f"h{i}",
                timestamp=float(i),
                message=f"m{i}",
            )
        )
    g.set_branch("main", "c5")

    between = g.commits_between("c2", "c5")
    # Should return c3, c4, c5 (exclusive of start)
    assert [c.id for c in between] == ["c3", "c4", "c5"]
