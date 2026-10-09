"""Tests for entity change generation."""

import pytest

from sivkit import Entity, entity_type
from sivkit.libs.model import transformed_entity


@entity_type
class _DiffTestEntity(Entity):
    name: str | None = ""


@pytest.mark.parametrize("value", ["value", None])
def test_entity_diff_and_application_preserve_values(value):
    before = _DiffTestEntity(id="e", name="before")
    after = _DiffTestEntity(id="e", name=value)
    change = before.change_from(after)
    assert change.reverse_component == {"name": "before"}
    assert change.forward_component == {"name": value}
    assert after.change_from(before).asdict() == change.reversed().asdict()
    assert transformed_entity(before, change).asdict() == after.asdict()
    assert transformed_entity(after, change.reversed()).asdict() == before.asdict()
    assert before.name == "before" and after.name == value
