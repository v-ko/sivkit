import errno
import os
import unicodedata

import pytest

from sivkit.storage.fs.names import UnsafeName
from sivkit.storage.fs.ops import (
    ABSENT,
    Conflict,
    UnsafePath,
    atomic_replace,
    check_new_path,
    create_new,
    delete,
    fingerprint,
    make_folder,
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

    # A long name gets a hashed temp name
    long_name = tmp_path / ("x" * 250)
    atomic_replace(long_name, b"data", expect=ABSENT)
    assert long_name.read_bytes() == b"data"
    assert sorted(os.listdir(tmp_path)) == ["page.html", "x" * 250]


def test_writes_need_an_existing_folder(tmp_path, hard_links):
    page = tmp_path / "page.html"
    page.write_bytes(b"p")
    missing = tmp_path / "missing" / "page.html"

    for write in [
        lambda: atomic_replace(missing, b"x"),
        lambda: create_new(missing, b"x"),
        lambda: move(page, missing),
    ]:
        with pytest.raises(FileNotFoundError):
            write()
    assert os.listdir(tmp_path) == ["page.html"]


def test_make_folder(tmp_path):
    (tmp_path / "page.html").write_bytes(b"p")

    make_folder(tmp_path / "notes")
    make_folder(tmp_path / "notes")  # Already there is fine
    with pytest.raises(FileNotFoundError):
        make_folder(tmp_path / "missing" / "sub")
    with pytest.raises(Conflict) as e:
        make_folder(tmp_path / "page.html")
    assert e.value.current == fingerprint(tmp_path / "page.html")
    (tmp_path / "linked").symlink_to(tmp_path / "notes")
    with pytest.raises(Conflict):
        make_folder(tmp_path / "linked")
    assert sorted(os.listdir(tmp_path)) == ["linked", "notes", "page.html"]


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

    # Into another folder, as the same file
    make_folder(tmp_path / "sub")
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
    resolve_in_root(tmp_path / "root-link", "notes/a")
    # Too long to exist: left to the name rules
    resolve_in_root(root, "x" * 300)

    for rel in [
        "",
        "/etc/passwd",
        "../outside/x",
        "notes/../../outside",
        "./notes/a",
        "notes//a",
        "notes/",
        "missing/a\0b",
        "missing/\ud800",
        "linked/x",
        "notes/page.html",
    ]:
        with pytest.raises(UnsafePath):
            resolve_in_root(root, rel)


def refusal(root, rel, source=None):
    try:
        check_new_path(root, rel, source=source)
    except UnsafeName as e:
        return e.reason
    return None


def test_check_new_path_refuses_colliding_names(tmp_path):
    (tmp_path / "notes").mkdir()
    (tmp_path / "notes" / "a.html").write_bytes(b"a")
    (tmp_path / "Page.html").write_bytes(b"p")

    assert refusal(tmp_path, "Notes/b.html") == "collision"
    assert refusal(tmp_path, "notes/A.html") == "collision"
    assert refusal(tmp_path, "PAGE.html", source="notes/a.html") == "collision"
    assert refusal(tmp_path, "notes/b.html") is None
    assert refusal(tmp_path, "new/sub/b.html") is None
    # The renamed file itself isn't a sibling, but can't become a folder
    assert refusal(tmp_path, "page.html", source="Page.html") is None
    assert refusal(tmp_path, "page.html/b.html", source="Page.html") == "collision"

    with pytest.raises(Conflict) as e:
        check_new_path(tmp_path, "Page.html/x.html")
    assert e.value.path == tmp_path / "Page.html"


def test_check_new_path_polices_only_new_names(tmp_path):
    nfd = unicodedata.normalize("NFD", "Café")
    (tmp_path / nfd).mkdir()
    (tmp_path / f"{nfd}.html").write_bytes(b"x")

    assert refusal(tmp_path, f"{nfd}/new.html") is None
    assert refusal(tmp_path, f"{nfd}.html") is None

    assert refusal(tmp_path, "a:b.html") == "char"
    assert refusal(tmp_path, f"new {nfd}.html") == "not_nfc"
    assert refusal(tmp_path, "new./a.html") == "trailing"
    assert refusal(tmp_path, "aux.html", source=f"{nfd}.html") == "reserved"
    assert refusal(tmp_path, "x" * 300) == "part_length"
    assert refusal(tmp_path, "/".join(["d" * 200] * 6)) == "path_length"
    assert refusal(tmp_path, "/".join(["d"] * 40)) == "depth"
