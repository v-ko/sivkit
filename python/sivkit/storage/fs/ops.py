"""File operations: blocking, with every policy choice an explicit argument.

See `docs/adr/102-file-system-access.md`. Callers resolve paths with
`resolve_in_root` first; these functions take the resulting paths. Writes
don't create folders: a missing one raises `FileNotFoundError`.
"""

import errno
import hashlib
import os
import secrets
import stat
from enum import Enum
from pathlib import Path
from typing import NamedTuple

from sivkit.storage.fs.names import (
    MAX_DEPTH,
    MAX_PATH_BYTES,
    UnsafeName,
    canonical_key,
    check_portable_name,
)


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
    except OSError as e:
        if e.errno == errno.ENAMETOOLONG:
            return None  # Can't exist
        raise
    return Fingerprint(st.st_size, st.st_mtime_ns, st.st_ino)


def resolve_in_root(root: Path, rel: str) -> Path:
    """`root / rel`, refusing any `rel` that could lead outside `root`.

    Containment only, no name rules. `root` itself may be a symlink; existing
    parts below it may not be symlinks or Windows junctions. A check, not a
    sandbox: a concurrent change to the tree can still redirect a later write.
    """
    if rel.startswith("/"):
        raise UnsafePath(rel, "absolute")
    if os.name == "nt" and ("\\" in rel or ":" in rel):
        raise UnsafePath(rel, "windows_syntax")
    parts = rel.split("/")
    if "" in parts:
        raise UnsafePath(rel, "empty")
    if "." in parts or ".." in parts:
        raise UnsafePath(rel, "dot")
    if "\0" in rel:
        raise UnsafePath(rel, "char")
    try:
        os.fsencode(rel)
    except UnicodeEncodeError:
        raise UnsafePath(rel, "char") from None
    path = root
    for part in parts:
        path = path / part
        try:
            st = os.lstat(path)
        except (FileNotFoundError, NotADirectoryError):
            break
        except OSError as e:
            if e.errno == errno.ENAMETOOLONG:
                break  # Can't exist; the name rules report it
            raise
        if (
            stat.S_ISLNK(st.st_mode)
            or getattr(st, "st_reparse_tag", 0) == _JUNCTION_TAG
        ):
            raise UnsafePath(rel, "link")
    return root / rel


def check_new_path(root: Path, rel: str, *, source: str | None = None) -> None:
    """Raises `UnsafeName` if a name that `rel` would introduce isn't portable or collides.

    A part is introduced if its folder has no entry of exactly that name;
    existing names are never checked. Introduced names are compared by
    `canonical_key` with their siblings on disk; `source` (a file being
    renamed to `rel`) doesn't count as one. Raises `Conflict` if an existing
    file is used as a folder.
    """
    folder = ""
    is_new = False
    parts = rel.split("/")
    for depth, part in enumerate(parts, 1):
        # Below a new part nothing exists yet
        siblings = {} if is_new else _listing_by_key(root / folder)
        same_key = siblings.get(canonical_key(part), [])
        if part not in same_key:
            if not is_new:
                is_new = True
                _check_path_limits(rel)
            try:
                check_portable_name(part)
            except UnsafeName as e:
                raise UnsafeName(rel, e.reason) from None
            vacated = source if depth == len(parts) else None
            if any(_join(folder, s) != vacated for s in same_key):
                raise UnsafeName(rel, "collision")
        folder = _join(folder, part)


def atomic_replace(
    path: Path, data: bytes, *, expect: Expect = ANY, durable: bool = True
) -> Fingerprint:
    """Replaces or creates `path` with `data`; a crash leaves the old or the new file.

    Keeps the old file's mode.
    """
    _check_expect(path, expect)
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


def move(
    src: Path, dst: Path, *, expect: Expect = ANY, durable: bool = True
) -> Fingerprint:
    """Renames the file `src` to `dst`; raises `Conflict` if `dst` exists, touching neither.

    A crash can leave both names on one file; the caller resolves that.
    Between file systems (`EXDEV`) it raises.
    """
    _check_expect(src, expect)
    if not stat.S_ISREG(os.lstat(src).st_mode):
        raise ValueError(f"{src} is not a regular file")
    if _is_case_only_change(src, dst):
        os.rename(src, dst)
    else:
        try:
            linked = _publish_no_clobber(src, dst)
        except FileExistsError:
            raise Conflict(dst, fingerprint(dst)) from None
        # The new name must be durable before the old one goes
        if durable and dst.parent != src.parent:
            fsync_dir(dst.parent)
        if linked:
            os.unlink(src)
    if durable:
        fsync_dir(src.parent)
    return _fingerprint(dst)


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


def make_folder(path: Path, *, durable: bool = True) -> None:
    """Creates the folder `path`; its parent must exist. An existing folder is fine.

    Raises `Conflict` if something else is at `path`.
    """
    try:
        os.mkdir(path)
    except FileExistsError:
        if not stat.S_ISDIR(os.lstat(path).st_mode):
            raise Conflict(path, fingerprint(path)) from None
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


def _join(folder: str, name: str) -> str:
    return f"{folder}/{name}" if folder else name


def _listing_by_key(folder: Path) -> dict[str, list[str]]:
    try:
        names = os.listdir(folder)
    except FileNotFoundError:
        return {}
    except NotADirectoryError:
        raise Conflict(folder, fingerprint(folder)) from None
    by_key: dict[str, list[str]] = {}
    for name in names:
        by_key.setdefault(canonical_key(name), []).append(name)
    return by_key


def _check_path_limits(rel: str) -> None:
    if len(rel.encode("utf-8", "surrogatepass")) > MAX_PATH_BYTES:
        raise UnsafeName(rel, "path_length")
    if rel.count("/") + 1 > MAX_DEPTH:
        raise UnsafeName(rel, "depth")


def _fingerprint(path: Path) -> Fingerprint:
    st = os.lstat(path)
    return Fingerprint(st.st_size, st.st_mtime_ns, st.st_ino)


def _check_expect(path: Path, expect: Expect) -> None:
    if expect is ANY:
        return
    current = fingerprint(path)
    if current != (None if expect is ABSENT else expect):
        raise Conflict(path, current)


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


def _publish_no_clobber(src: Path, dst: Path) -> bool:
    """Gives `src` the name `dst`; raises `FileExistsError` if `dst` exists.

    Returns True if it hard-linked, so `src` still exists.
    """
    if os.name == "nt":
        os.rename(src, dst)
        return False
    try:
        os.link(src, dst)
        return True
    except OSError as e:
        if e.errno not in _LINK_UNSUPPORTED:
            raise
        # No hard links here (FAT, some network shares): a small window, as in git
        if os.path.lexists(dst):
            raise FileExistsError(errno.EEXIST, "File exists", str(dst)) from None
        os.rename(src, dst)
        return False


def _is_case_only_change(src: Path, dst: Path) -> bool:
    """`dst` is another spelling of `src`'s own entry, on a case-folding file system."""
    try:
        st = os.lstat(src)
        # With one link, the same inode means the same entry, not a hard-link alias
        same = st.st_nlink == 1 and os.path.samestat(st, os.lstat(dst))
        return same and dst.name not in os.listdir(dst.parent)
    except (FileNotFoundError, NotADirectoryError):
        return False
