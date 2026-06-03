import pytest

from sivkit import Entity, entity_type


@entity_type
class _DummyPage(Entity):
    name: str = ""


@entity_type
class _DummyNote(Entity):
    test_prop: str = ""


@pytest.fixture
def DummyPage():
    return _DummyPage


@pytest.fixture
def DummyNote():
    return _DummyNote
