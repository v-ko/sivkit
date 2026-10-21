"""Durable file changes for async code, one worker thread trip per change.

Fixes the arguments of `ops` to the policy in `docs/adr/102-file-system-access.md`.
Apps run independent changes concurrently with `asyncio.gather` and order
dependent ones themselves. Folders are the app's: it creates them with
`ops.make_folder`.
"""

import asyncio
import os
import stat
from dataclasses import dataclass
from pathlib import Path

from sivkit.storage.fs.names import UnsafeName
from sivkit.storage.fs.ops import (
    Conflict,
    Fingerprint,
    UnsafePath,
    _is_case_only_change,
    atomic_replace,
    check_new_path,
    create_new,
    delete,
    fingerprint,
    move,
    resolve_in_root,
)


@dataclass(frozen=True)
class Create:
    """Creates a file; refused if `rel` exists."""

    rel: str
    data: bytes


@dataclass(frozen=True)
class Replace:
    """Replaces a file's contents; a missing file is created."""

    rel: str
    data: bytes


@dataclass(frozen=True)
class Rename:
    """Gives a file a new name and new contents; plain moves use `ops.move`.

    The new name is published before the old one is removed. Unless only the
    case changes, the result is a new file with default permissions.
    """

    old: str
    new: str
    data: bytes


@dataclass(frozen=True)
class Delete:
    """Deletes a file; a missing file counts as done."""

    rel: str


Change = Create | Replace | Rename | Delete


@dataclass(frozen=True)
class ApplyResult:
    """The outcome of one change; `error` is None when it's done.

    A refusal (`UnsafeName`, `UnsafePath`, `Conflict`) means nothing changed.
    An `OSError` means the change's paths are in an unknown state. `fingerprint`
    is the written file's, None for a delete or an error.
    """

    change: Change
    fingerprint: Fingerprint | None = None
    error: Exception | None = None


# `shield` keeps no reference to the tasks it protects
_running: set[asyncio.Future] = set()


async def apply(root: Path, change: Change) -> ApplyResult:
    """Runs `change` on the files under `root`; paths are relative, with `/`.

    Only names the change introduces are checked. A cancelled caller returns
    early, and the change still runs to the end.
    """
    if not isinstance(change, (Create, Replace, Rename, Delete)):
        raise TypeError(f"Unknown change: {change!r}")
    task = asyncio.ensure_future(asyncio.to_thread(_apply, root, change))
    _running.add(task)
    task.add_done_callback(_running.discard)
    return await asyncio.shield(task)


def _apply(root: Path, change: Change) -> ApplyResult:
    try:
        return ApplyResult(change, fingerprint=_run(root, change))
    except Conflict as e:
        error = Conflict(e.path.relative_to(root), e.current)
        return ApplyResult(change, error=error)
    except (UnsafeName, UnsafePath, OSError) as e:
        return ApplyResult(change, error=e)


def _run(root: Path, change: Change) -> Fingerprint | None:
    if isinstance(change, Create):
        path = resolve_in_root(root, change.rel)
        check_new_path(root, change.rel)
        _check_parent(path)
        _check_absent(path)
        return create_new(path, change.data)

    if isinstance(change, Replace):
        path = resolve_in_root(root, change.rel)
        if _file_fingerprint(path) is None:
            check_new_path(root, change.rel)
            _check_parent(path)
        return atomic_replace(path, change.data)

    if isinstance(change, Rename):
        old = resolve_in_root(root, change.old)
        new = resolve_in_root(root, change.new)
        if _file_fingerprint(old) is None:
            raise Conflict(old, None)
        check_new_path(root, change.new, source=change.old)
        _check_parent(new)
        if _is_case_only_change(old, new):
            # The move refuses before anything changes; the write after it only fails
            move(old, new)
            return atomic_replace(new, change.data)
        _check_absent(new)
        done = create_new(new, change.data)
        delete(old)
        return done

    path = resolve_in_root(root, change.rel)
    if _file_fingerprint(path) is not None:
        delete(path)
    return None


def _file_fingerprint(path: Path) -> Fingerprint | None:
    """None if `path` is absent; `Conflict` if it isn't a regular file."""
    current = fingerprint(path)
    if current is not None and not stat.S_ISREG(os.lstat(path).st_mode):
        raise Conflict(path, current)
    return current


def _check_parent(path: Path) -> None:
    if not os.path.isdir(path.parent):
        raise Conflict(path.parent, fingerprint(path.parent))


def _check_absent(path: Path) -> None:
    current = fingerprint(path)
    if current is not None:
        raise Conflict(path, current)
