import errno
import os
import time

import pytest

from sivkit.storage.fs.ops import (
    ABSENT,
    Conflict,
    UnsafePath,
    atomic_replace,
    clean_temps,
    create_new,
    delete,
    fingerprint,
    move,
    resolve_in_root,
)


@pytest.fixture(params=[True, False], ids=["hard_links", "no_hard_links"])
def hard_links(request, monkeypatch):
    if not request.param:

        def no_link(src, dst):
            raise OSError(errno.EPERM, "Operation not permitted")

        monkeypatch.setattr(os, "link", no_link)


def listing(root):
    return sorted(p.relative_to(root).as_posix() for p in root.rglob("*"))


def test_atomic_replace_keeps_mode_and_leaves_no_temp(tmp_path):
    page = tmp_path / "page.html"
    page.write_bytes(b"old")
    page.chmod(0o640)

    done = atomic_replace(page, b"new", expect=fingerprint(page))

    assert page.read_bytes() == b"new"
    assert page.stat().st_mode & 0o777 == 0o640
    assert done == fingerprint(page)

    # Missing folders are created; a long name gets a hashed temp name
    long_name = tmp_path / "a" / "b" / ("x" * 250)
    atomic_replace(long_name, b"data", expect=ABSENT)
    assert long_name.read_bytes() == b"data"
    assert sorted(p.name for p in tmp_path.rglob("*")) == sorted(
        ["page.html", "a", "b", "x" * 250]
    )


@pytest.mark.parametrize("failing", ["fsync", "replace"])
def test_failed_replace_keeps_old_file(tmp_path, monkeypatch, failing):
    page = tmp_path / "page.html"
    page.write_bytes(b"old")

    def fail(*args):
        raise OSError(errno.EIO, "I/O error")

    monkeypatch.setattr(os, failing, fail)
    with pytest.raises(OSError):
        atomic_replace(page, b"new")
    assert page.read_bytes() == b"old"
    assert os.listdir(tmp_path) == ["page.html"]


def test_expect_mismatch_writes_nothing(tmp_path):
    page = tmp_path / "page.html"
    page.write_bytes(b"v1")
    seen = fingerprint(page)
    page.write_bytes(b"outside edit")

    with pytest.raises(Conflict) as e:
        atomic_replace(page, b"v2", expect=seen)
    assert e.value.current == fingerprint(page)
    with pytest.raises(Conflict):
        atomic_replace(page, b"v2", expect=ABSENT)
    with pytest.raises(Conflict):
        delete(page, expect=seen)
    assert page.read_bytes() == b"outside edit"
    assert os.listdir(tmp_path) == ["page.html"]

    delete(page, expect=fingerprint(page))
    delete(page)  # Already gone is fine with the default ANY
    with pytest.raises(Conflict):
        delete(page, expect=seen)
    assert os.listdir(tmp_path) == []


def test_create_new_never_overwrites(tmp_path, hard_links):
    page = tmp_path / "page.html"
    done = create_new(page, b"first")
    assert done == fingerprint(page)

    with pytest.raises(Conflict) as e:
        create_new(page, b"second")
    assert e.value.current == done
    assert page.read_bytes() == b"first"
    assert os.listdir(tmp_path) == ["page.html"]


def test_move_never_overwrites(tmp_path, hard_links):
    a = tmp_path / "a.html"
    b = tmp_path / "b.html"
    a.write_bytes(b"a")
    b.write_bytes(b"b")
    seen = fingerprint(a)

    with pytest.raises(Conflict) as e:
        move(a, b)
    assert e.value.current == fingerprint(b)
    with pytest.raises(Conflict):
        move(a, tmp_path / "c.html", expect=ABSENT)
    assert (a.read_bytes(), b.read_bytes()) == (b"a", b"b")

    # Into a new folder, as the same file
    done = move(a, tmp_path / "sub" / "a.html", expect=seen)
    assert done.inode == seen.inode
    assert listing(tmp_path) == ["b.html", "sub", "sub/a.html"]


def test_move_refuses_another_name_of_the_same_file(tmp_path):
    page = tmp_path / "page.html"
    page.write_bytes(b"x")
    os.link(page, tmp_path / "copy.html")

    with pytest.raises(Conflict):
        move(page, tmp_path / "copy.html")
    assert sorted(os.listdir(tmp_path)) == ["copy.html", "page.html"]


def test_move_case_only(tmp_path):
    page = tmp_path / "page.html"
    page.write_bytes(b"x")
    if not (tmp_path / "PAGE.HTML").exists():
        pytest.skip("case-only renames need a case-folding file system")

    move(page, tmp_path / "Page.html")
    assert os.listdir(tmp_path) == ["Page.html"]


def test_resolve_in_root_refuses_escapes(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    root = tmp_path / "root"
    (root / "notes").mkdir(parents=True)
    (root / "linked").symlink_to(outside)
    (root / "notes" / "page.html").symlink_to(outside / "x")

    assert resolve_in_root(root, "notes/new/page.html") == root / "notes/new/page.html"
    # The root itself may be a link
    (tmp_path / "root-link").symlink_to(root)
    resolve_in_root(tmp_path / "root-link", "./notes/a")

    for rel in [
        "",
        "/etc/passwd",
        "../outside/x",
        "notes/../../outside",
        "linked/x",
        "notes/page.html",
    ]:
        with pytest.raises(UnsafePath):
            resolve_in_root(root, rel)


def test_clean_temps_deletes_only_old_temps(tmp_path):
    old = time.time() - 3600
    names = {
        "a/.page.html.0123456789abcdef.tmp": old,  # deleted
        "a/.page.html.0123456789abcdef.tmp.bak": old,
        "a/.page.html.tmp": old,
        "a/page.html.tmp": old,
        ".young.html.0123456789abcdef.tmp": time.time(),
        "ignored/.page.html.0123456789abcdef.tmp": old,
    }
    for rel, mtime in names.items():
        path = tmp_path / rel
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(b"")
        os.utime(path, (mtime, mtime))

    assert clean_temps(tmp_path, lambda rel: rel == "ignored") == []
    left = {
        p.relative_to(tmp_path).as_posix() for p in tmp_path.rglob("*") if p.is_file()
    }
    assert left == set(names) - {"a/.page.html.0123456789abcdef.tmp"}
