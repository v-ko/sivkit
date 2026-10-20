"""File operations: blocking, with every policy choice an explicit argument.

See `docs/adr/102-file-system-access.md`. Callers resolve paths with
`resolve_in_root` first; these functions take the resulting paths.
"""

import errno
import hashlib
import os
import re
import secrets
import stat
import time
from collections.abc import Callable
from enum import Enum
from pathlib import Path
from typing import NamedTuple


class Fingerprint(NamedTuple):
    size: int
    mtime_ns: int
    inode: int


class _Expect(Enum):
    ANY = "any"
    ABSENT = "absent"


ANY = _Expect.ANY
ABSENT = _Expect.ABSENT
Expect = Fingerprint | _Expect


class Conflict(Exception):
    """The file isn't as expected; nothing was written. `current` is None if it's absent."""

    def __init__(self, path: Path, current: Fingerprint | None):
        super().__init__(f"{path} changed on disk")
        self.path = path
        self.current = current


class UnsafePath(ValueError):
    """A relative path that could lead outside its root."""

    def __init__(self, rel: str, reason: str):
        super().__init__(f"Unsafe path {rel!r}: {reason}")
        self.rel = rel
        self.reason = reason


_TEMP_PATTERN = re.compile(r"\..+\.[0-9a-f]{16}\.tmp", re.DOTALL)
_TEMP_EXTRA_BYTES = len(".") + len(".0123456789abcdef.tmp")
_MAX_NAME_BYTES = 255
_LINK_UNSUPPORTED = {errno.EPERM, errno.EOPNOTSUPP, errno.ENOTSUP, errno.ENOSYS}
_DIR_FSYNC_UNSUPPORTED = {errno.EINVAL, errno.EOPNOTSUPP, errno.ENOTSUP}
_JUNCTION_TAG = 0xA0000003  # IO_REPARSE_TAG_MOUNT_POINT; `stat` has it only on Windows


def fingerprint(path: Path) -> Fingerprint | None:
    """`(size, mtime_ns, inode)` of `path` itself (not a link's target), or None if absent."""
    try:
        st = os.lstat(path)
    except (FileNotFoundError, NotADirectoryError):
        return None
    return Fingerprint(st.st_size, st.st_mtime_ns, st.st_ino)


def resolve_in_root(root: Path, rel: str) -> Path:
    """`root / rel`, refusing any `rel` that could lead outside `root`.

    Containment only, no name rules. `root` itself may be a symlink; existing
    parts below it may not be symlinks or Windows junctions. A check, not a
    sandbox: a concurrent change to the tree can still redirect a later write.
    """
    if rel == "":
        raise UnsafePath(rel, "empty")
    if rel.startswith("/"):
        raise UnsafePath(rel, "absolute")
    if os.name == "nt" and ("\\" in rel or ":" in rel):
        raise UnsafePath(rel, "windows_syntax")
    parts = rel.split("/")
    if ".." in parts:
        raise UnsafePath(rel, "dot")
    path = root
    for part in parts:
        if part in ("", "."):
            continue
        path = path / part
        try:
            st = os.lstat(path)
        except (FileNotFoundError, NotADirectoryError):
            break
        if (
            stat.S_ISLNK(st.st_mode)
            or getattr(st, "st_reparse_tag", 0) == _JUNCTION_TAG
        ):
            raise UnsafePath(rel, "link")
    return root / rel


def atomic_replace(
    path: Path, data: bytes, *, expect: Expect = ANY, durable: bool = True
) -> Fingerprint:
    """Replaces or creates `path` with `data`; a crash leaves the old or the new file.

    Keeps the old file's mode. Creates missing folders.
    """
    _check_expect(path, expect)
    _make_folders(path.parent, durable)
    try:
        mode = stat.S_IMODE(os.stat(path).st_mode)
    except FileNotFoundError:
        mode = None
    temp = _write_temp(path, data, mode, durable)
    try:
        os.replace(temp, path)
    except BaseException:
        temp.unlink(missing_ok=True)
        raise
    if durable:
        fsync_dir(path.parent)
    return _fingerprint(path)


def create_new(path: Path, data: bytes, *, durable: bool = True) -> Fingerprint:
    """Creates `path` with `data`; raises `Conflict` if it exists, without touching it."""
    _make_folders(path.parent, durable)
    temp = _write_temp(path, data, None, durable)
    try:
        _publish_no_clobber(temp, path)
    except FileExistsError:
        raise Conflict(path, fingerprint(path)) from None
    finally:
        temp.unlink(missing_ok=True)
    if durable:
        fsync_dir(path.parent)
    return _fingerprint(path)


def delete(path: Path, *, expect: Expect = ANY, durable: bool = True) -> None:
    """Deletes the file `path`. A missing file is fine unless `expect` is a fingerprint."""
    _check_expect(path, expect)
    try:
        os.unlink(path)
    except FileNotFoundError:
        if not isinstance(expect, _Expect):
            raise Conflict(path, None) from None
        return
    if durable:
        fsync_dir(path.parent)


def fsync_dir(path: Path) -> None:
    """Makes the folder's entries durable. No-op on Windows."""
    if os.name == "nt":
        return
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(fd)
    except OSError as e:
        # Some network and FUSE file systems can't sync folders at all
        if e.errno not in _DIR_FSYNC_UNSUPPORTED:
            raise
    finally:
        os.close(fd)


def clean_temps(
    root: Path, ignore: Callable[[str], bool], *, min_age: float = 60
) -> list[str]:
    """Deletes this module's temp files older than `min_age` seconds.

    `ignore` takes `/`-separated paths relative to `root`; ignored folders
    aren't entered. Returns the relative paths that couldn't be listed or deleted.
    """
    failed: list[str] = []

    def rel_of(path: str) -> str:
        return Path(path).relative_to(root).as_posix()

    cutoff = time.time() - min_age
    walk = os.walk(root, onerror=lambda e: failed.append(rel_of(e.filename)))
    for folder, dirs, files in walk:
        # os.walk skips symlinked folders but enters junctions
        dirs[:] = [
            d
            for d in dirs
            if not _is_junction(os.path.join(folder, d))
            and not ignore(rel_of(os.path.join(folder, d)))
        ]
        for name in files:
            if not _TEMP_PATTERN.fullmatch(name):
                continue
            path = os.path.join(folder, name)
            if ignore(rel_of(path)):
                continue
            try:
                st = os.lstat(path)
                if stat.S_ISREG(st.st_mode) and st.st_mtime < cutoff:
                    os.unlink(path)
            except FileNotFoundError:
                pass
            except OSError:
                failed.append(rel_of(path))
    return failed


def _is_junction(path: str) -> bool:
    try:
        return getattr(os.lstat(path), "st_reparse_tag", 0) == _JUNCTION_TAG
    except OSError:
        return False


def _fingerprint(path: Path) -> Fingerprint:
    st = os.lstat(path)
    return Fingerprint(st.st_size, st.st_mtime_ns, st.st_ino)


def _check_expect(path: Path, expect: Expect) -> None:
    if expect is ANY:
        return
    current = fingerprint(path)
    if current != (None if expect is ABSENT else expect):
        raise Conflict(path, current)


def _make_folders(folder: Path, durable: bool) -> None:
    missing = []
    while not folder.exists():
        missing.append(folder)
        folder = folder.parent
    for created in reversed(missing):
        created.mkdir(exist_ok=True)
        if durable:
            fsync_dir(created.parent)


def _temp_name(name: str) -> str:
    if len(os.fsencode(name)) + _TEMP_EXTRA_BYTES > _MAX_NAME_BYTES:
        name = hashlib.sha256(os.fsencode(name)).hexdigest()
    return f".{name}.{secrets.token_hex(8)}.tmp"


def _write_temp(path: Path, data: bytes, mode: int | None, durable: bool) -> Path:
    temp = path.with_name(_temp_name(path.name))
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
    # Private until the old mode is applied, so a copy of a 0600 file isn't readable
    fd = os.open(temp, flags, 0o666 if mode is None else 0o600)
    try:
        with os.fdopen(fd, "wb") as file:
            file.write(data)
            file.flush()  # Before chmod: a write clears setuid bits
            # Windows has only a read-only bit, and can't replace a read-only file anyway
            if mode is not None and os.name != "nt":
                os.chmod(temp, mode)
            if durable:
                os.fsync(file.fileno())
    except BaseException:
        temp.unlink(missing_ok=True)
        raise
    return temp


def _publish_no_clobber(temp: Path, path: Path) -> None:
    """Gives `temp` the name `path`; raises `FileExistsError` if `path` exists."""
    if os.name == "nt":
        os.rename(temp, path)
        return
    try:
        os.link(temp, path)
    except OSError as e:
        if e.errno not in _LINK_UNSUPPORTED:
            raise
        # No hard links here (FAT, some network shares): a small window, as in git
        if os.path.lexists(path):
            raise FileExistsError(errno.EEXIST, "File exists", str(path)) from None
        os.rename(temp, path)
