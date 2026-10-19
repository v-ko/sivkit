import pytest

from sivkit.storage.fs.names import UnsafeName, canonical_key, check_portable_path


@pytest.mark.parametrize(
    "rel",
    [
        "Notes/\u00dcn\u00efcode.canvas.html",
        "\U0001f469\u200d\U0001f4bb.png",
        "CONSOLE.txt",
    ],
)
def test_portable(rel):
    check_portable_path(rel)


@pytest.mark.parametrize(
    "rel",
    ["../x", "CON.txt", "e\u0301.png", "a?b", "notes.", "a" * 256],
    ids=["dotdot", "reserved", "nfd", "forbidden", "trailing_dot", "too_long"],
)
def test_not_portable(rel):
    with pytest.raises(UnsafeName):
        check_portable_path(rel)


def test_case_variants_share_a_key():
    assert canonical_key("Stra\u00dfe/Notes") == canonical_key("STRASSE/notes")
