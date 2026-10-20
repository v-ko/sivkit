import pytest

from sivkit.storage.blob_store import BlobStore, UnsafePath


def test_blob_paths_stay_inside_the_root(tmp_path):
    store = BlobStore(tmp_path / "media")
    rel = store.add(b"data", "jpg")
    (tmp_path / "secret").write_bytes(b"secret")
    (tmp_path / "media" / "linked").symlink_to(tmp_path)

    for unsafe in ["../secret", "/etc/passwd", "linked/secret"]:
        with pytest.raises(UnsafePath):
            store.get_path(unsafe)
    path = store.get_path(rel)
    assert path is not None and path.read_bytes() == b"data"
    assert store.remove(rel)
