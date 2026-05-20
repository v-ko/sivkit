"""Content-addressed blob storage.

Files are stored using their SHA-256 hash as the filename, with a 2-character
prefix directory for filesystem scalability:

    <root>/ab/ab3f4e…deadbeef.jpg

Provides deduplication (same content = same file) and stable paths regardless
of how entities referencing the blobs are reorganized.
"""

from __future__ import annotations

import hashlib
from pathlib import Path, PurePosixPath

CONTENT_HASH_HEX_LEN = 32


class BlobStore:
    """Content-addressed file blob storage."""

    def __init__(self, root: Path) -> None:
        self._root = root
        self._root.mkdir(parents=True, exist_ok=True)

    @property
    def root(self) -> Path:
        return self._root

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
        return rel_path

    def get_path(self, rel_path: str) -> Path | None:
        """Resolve a relative blob path to an absolute filesystem path.

        Returns None if the file doesn't exist or the path is invalid.
        """
        if not _is_safe_path(rel_path):
            return None
        abs_path = self._root / rel_path
        if not abs_path.exists():
            return None
        return abs_path

    def exists(self, rel_path: str) -> bool:
        """Check if a blob exists at the given relative path."""
        if not _is_safe_path(rel_path):
            return False
        return (self._root / rel_path).exists()

    def remove(self, rel_path: str) -> bool:
        """Remove a blob by relative path. Returns True if deleted."""
        if not _is_safe_path(rel_path):
            return False
        abs_path = self._root / rel_path
        if not abs_path.exists():
            return False
        abs_path.unlink()
        # Remove parent dir if empty
        try:
            abs_path.parent.rmdir()
        except OSError:
            pass  # Not empty, that's fine
        return True

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


def _is_safe_path(rel_path: str) -> bool:
    """Reject absolute paths and directory traversals."""
    p = PurePosixPath(rel_path)
    return not p.is_absolute() and ".." not in p.parts
