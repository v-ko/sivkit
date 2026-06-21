"""Content-addressed blob storage.

Files are stored using their SHA-256 hash as the filename, with a 2-character
prefix directory for filesystem scalability:

    <root>/ab/ab3f4e…deadbeef.jpg

Provides deduplication (same content = same file) and stable paths regardless
of how entities referencing the blobs are reorganized.
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable
from pathlib import Path, PurePosixPath

CONTENT_HASH_HEX_LEN = 32


class UnsafePath(Exception):
    """Raised when a blob path fails safety validation."""


class BlobStore:
    """Content-addressed file blob storage."""

    def __init__(self, root: Path) -> None:
        self._root = root
        self._root.mkdir(parents=True, exist_ok=True)
        self._on_added_callbacks: list[Callable[[str, bytes], None]] = []

    @property
    def root(self) -> Path:
        return self._root

    def add_on_added_callback(self, cb: Callable[[str, bytes], None]) -> None:
        """Register a callback invoked when a new blob is added (not dedup)."""
        self._on_added_callbacks.append(cb)

    def remove_on_added_callback(self, cb: Callable[[str, bytes], None]) -> None:
        """Remove a previously registered on_added callback."""
        self._on_added_callbacks.remove(cb)

    def add(self, data: bytes, extension: str = "") -> str:
        """Store blob data, return the relative path (e.g. 'ab/ab3f…dead.jpg').

        If a blob with the same hash already exists, this is a no-op and the
        existing path is returned (deduplication).
        """
        content_hash = _compute_hash(data)
        rel_path = _hash_to_rel_path(content_hash, extension)
        abs_path = self._root / rel_path
        if not abs_path.exists():
            abs_path.parent.mkdir(parents=True, exist_ok=True)
            abs_path.write_bytes(data)
            for cb in self._on_added_callbacks:
                cb(rel_path, data)
        return rel_path

    def get_path(self, rel_path: str) -> Path | None:
        """Resolve a relative blob path to an absolute filesystem path.

        Returns None if the file doesn't exist.
        Raises UnsafePath if the path fails safety validation.
        """
        abs_path = self._resolve_safe(rel_path)
        if not abs_path.exists():
            return None
        return abs_path

    def exists(self, rel_path: str) -> bool:
        """Check if a blob exists at the given relative path."""
        abs_path = self._resolve_safe(rel_path)
        return abs_path.exists()

    def remove(self, rel_path: str) -> bool:
        """Remove a blob by relative path. Returns True if deleted."""
        abs_path = self._resolve_safe(rel_path)
        if not abs_path.exists():
            return False
        abs_path.unlink()
        # Remove parent dir if empty
        try:
            abs_path.parent.rmdir()
        except OSError:
            pass  # Not empty, that's fine
        return True

    def _resolve_safe(self, rel_path: str) -> Path:
        """Validate and resolve a relative path within the store root.

        Raises UnsafePath if the path escapes the root.
        """
        _check_safe_path(rel_path)
        abs_path = (self._root / rel_path).resolve()
        if not abs_path.is_relative_to(self._root.resolve()):
            raise UnsafePath(f"Path escapes blob store root: {rel_path!r}")
        return abs_path

    def hash_for_data(self, data: bytes) -> str:
        """Compute the content hash for data without storing it."""
        return _compute_hash(data)


def _compute_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:CONTENT_HASH_HEX_LEN]


def _hash_to_rel_path(content_hash: str, extension: str) -> str:
    """Convert a content hash to a relative storage path."""
    prefix = content_hash[:2]
    ext = (
        extension if extension.startswith(".") else f".{extension}" if extension else ""
    )
    return f"{prefix}/{content_hash}{ext}"


def _check_safe_path(rel_path: str) -> None:
    """Reject absolute paths and directory traversals."""
    p = PurePosixPath(rel_path)
    if p.is_absolute() or ".." in p.parts:
        raise UnsafePath(f"Unsafe blob path: {rel_path!r}")
