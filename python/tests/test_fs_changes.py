import asyncio
import errno
import io
import os
import threading
import unicodedata
from pathlib import Path

import pytest

from sivkit.storage.fs import changes
from sivkit.storage.fs.changes import (
    ApplyResult,
    Create,
    Delete,
    Rename,
    Replace,
    apply,
)
from sivkit.storage.fs.names import UnsafeName
from sivkit.storage.fs.ops import Conflict, UnsafePath, fingerprint, make_folder


def snapshot(root):
    return {
        p.relative_to(root).as_posix(): p.read_bytes() if p.is_file() else None
        for p in root.rglob("*")
    }


@pytest.mark.asyncio
async def test_each_change_returns_its_fingerprint(tmp_path):
    page = tmp_path / "page.html"

    done = await apply(tmp_path, Create("page.html", b"v1"))
    assert done == ApplyResult(Create("page.html", b"v1"), fingerprint(page))

    done = await apply(tmp_path, Replace("page.html", b"v2"))
    assert (done.fingerprint, done.error) == (fingerprint(page), None)

    # A missing file is written as new
    done = await apply(tmp_path, Replace("other.html", b"o"))
    assert done.error is None
    assert done.fingerprint == fingerprint(tmp_path / "other.html")
    assert (tmp_path / "other.html").read_bytes() == b"o"

    make_folder(tmp_path / "sub")
    done = await apply(tmp_path, Rename("page.html", "sub/page.html", b"v3"))
    assert done.fingerprint == fingerprint(tmp_path / "sub" / "page.html")

    done = await apply(tmp_path, Delete("other.html"))
    assert (done.fingerprint, done.error) == (None, None)
    # A missing file counts as done
    assert (await apply(tmp_path, Delete("other.html"))).error is None

    assert snapshot(tmp_path) == {"sub": None, "sub/page.html": b"v3"}


@pytest.mark.asyncio
async def test_case_only_rename(tmp_path):
    (tmp_path / "page.html").write_bytes(b"old")

    done = await apply(tmp_path, Rename("page.html", "Page.html", b"new"))

    assert done.error is None
    assert snapshot(tmp_path) == {"Page.html": b"new"}


@pytest.mark.asyncio
async def test_refusals_change_nothing(tmp_path):
    (tmp_path / "page.html").write_bytes(b"page")
    (tmp_path / "other.html").write_bytes(b"other")
    (tmp_path / "notes").mkdir()
    before = snapshot(tmp_path)

    refused = {
        Create("a:b.html", b"x"): UnsafeName,
        Create("Notes", b"x"): UnsafeName,
        Create("../page.html", b"x"): UnsafePath,
        Create("page.html", b"x"): Conflict,
        Create("missing/page.html", b"x"): Conflict,
        Replace("page.html/x", b"x"): Conflict,
        Replace("notes", b"x"): Conflict,
        Rename("page.html", "other.html", b"x"): Conflict,
        Rename("gone.html", "new.html", b"x"): Conflict,
        Rename("page.html", "missing/page.html", b"x"): Conflict,
        Delete("notes"): Conflict,
    }
    for change, error_type in refused.items():
        done = await apply(tmp_path, change)
        assert type(done.error) is error_type, change
        assert done.fingerprint is None
        if isinstance(done.error, Conflict):
            assert not done.error.path.is_absolute()
    assert snapshot(tmp_path) == before

    done = await apply(tmp_path, Create("missing/page.html", b"x"))
    assert done.error.path == Path("missing")


@pytest.mark.asyncio
async def test_rename_refuses_another_name_of_the_same_file(tmp_path):
    (tmp_path / "page.html").write_bytes(b"page")
    try:
        os.link(tmp_path / "page.html", tmp_path / "Page.html")
    except FileExistsError:
        pytest.skip("needs a case-sensitive file system")

    done = await apply(tmp_path, Rename("page.html", "Page.html", b"x"))

    assert isinstance(done.error, Conflict)
    assert snapshot(tmp_path) == {"Page.html": b"page", "page.html": b"page"}


@pytest.mark.asyncio
async def test_existing_names_are_not_checked(tmp_path):
    nfd = unicodedata.normalize("NFD", "café")
    make_folder(tmp_path / nfd)
    (tmp_path / "CON.html").write_bytes(b"old")

    assert (await apply(tmp_path, Replace("CON.html", b"new"))).error is None
    # A moved file keeps its name
    done = await apply(tmp_path, Rename("CON.html", f"{nfd}/CON.html", b"moved"))
    assert done.error is None
    done = await apply(
        tmp_path, Rename(f"{nfd}/CON.html", f"{nfd}/page.html", b"renamed")
    )
    assert done.error is None
    assert snapshot(tmp_path) == {nfd: None, f"{nfd}/page.html": b"renamed"}


class _FullDisk(io.BytesIO):
    def write(self, data):
        raise OSError(errno.ENOSPC, "No space left on device")


def _fail_fsync(fd):
    raise OSError(errno.EIO, "I/O error")


def _fail_write(fd, mode):
    os.close(fd)
    return _FullDisk()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "patch", [("fsync", _fail_fsync), ("fdopen", _fail_write)], ids=["fsync", "write"]
)
async def test_failed_write_leaves_no_temp(tmp_path, monkeypatch, patch):
    (tmp_path / "page.html").write_bytes(b"old")
    monkeypatch.setattr(os, *patch)

    for change in [Create("new.html", b"x"), Replace("page.html", b"new")]:
        done = await apply(tmp_path, change)
        assert isinstance(done.error, OSError)
    assert snapshot(tmp_path) == {"page.html": b"old"}


@pytest.mark.asyncio
async def test_rename_failing_after_publish_keeps_both_names(tmp_path, monkeypatch):
    (tmp_path / "old.html").write_bytes(b"old")

    def fail(path):
        raise OSError(errno.EIO, "I/O error")

    monkeypatch.setattr(changes, "delete", fail)
    done = await apply(tmp_path, Rename("old.html", "new.html", b"new"))

    assert isinstance(done.error, OSError)
    assert snapshot(tmp_path) == {"new.html": b"new", "old.html": b"old"}


@pytest.mark.asyncio
async def test_cancelled_caller_returns_and_the_change_completes(tmp_path, monkeypatch):
    started, release, finished = (threading.Event() for _ in range(3))
    create_new = changes.create_new

    def slow_create_new(path, data):
        started.set()
        release.wait(5)
        try:
            return create_new(path, data)
        finally:
            finished.set()

    monkeypatch.setattr(changes, "create_new", slow_create_new)
    task = asyncio.create_task(apply(tmp_path, Create("page.html", b"x")))
    try:
        assert await asyncio.to_thread(started.wait, 5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    finally:
        release.set()
    assert await asyncio.to_thread(finished.wait, 5)
    assert snapshot(tmp_path) == {"page.html": b"x"}


@pytest.mark.asyncio
async def test_concurrent_changes_in_one_folder(tmp_path):
    for i in range(10):
        (tmp_path / f"old{i}.html").write_bytes(b"old")

    results = await asyncio.gather(
        *[apply(tmp_path, Create(f"new{i}.html", b"new")) for i in range(10)],
        *[apply(tmp_path, Replace(f"old{i}.html", b"new")) for i in range(10)],
    )

    assert [r.error for r in results] == [None] * 20
    assert set(snapshot(tmp_path).values()) == {b"new"}
    assert len(os.listdir(tmp_path)) == 20


@pytest.mark.asyncio
async def test_unknown_change_raises(tmp_path):
    with pytest.raises(TypeError):
        await apply(tmp_path, "page.html")
