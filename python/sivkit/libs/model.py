from __future__ import annotations

import json
import logging
from typing import Type, TypeVar, dataclass_transform

import attrs

import sivkit
from sivkit.util import get_new_id

log = logging.getLogger(__name__)

_EntityT = TypeVar("_EntityT", bound="Entity")
entity_library = {}


_last_entity_id = 0


def get_entity_id():
    global _last_entity_id
    if sivkit.reproducible_ids():
        _last_entity_id += 1
        return str(_last_entity_id).zfill(8)
    else:
        return get_new_id()


def reset_entity_id_counter():
    global _last_entity_id
    _last_entity_id = 0
    # For debugging purposes


T = TypeVar("T")


@dataclass_transform()
def entity_type(entity_class: Type[T], repr: bool = False) -> Type[T]:
    """A class decorator to register entities in the entity library for the
    purposes of serialization and deserialization. It applies attrs.define.
    """
    if hasattr(entity_class, "type_name"):
        raise Exception(
            "The type_name identifier is used in the serialization and is prohibited."
        )

    entity_class = attrs.define(
        entity_class,
        slots=True,
        repr=repr,
        hash=False,
        eq=False,
    )

    # Register the entity class
    entity_class_name = entity_class.__name__
    if entity_class_name in entity_library:
        raise Exception(
            "This entity class name is already registered: %s" % entity_class_name
        )

    entity_library[entity_class_name] = entity_class
    return entity_class


def get_entity_class_by_name(entity_class_name: str):
    if entity_class_name not in entity_library:
        raise Exception(
            f"Entity class {entity_class_name} not found in "
            "entity library. Have you added the @entity_type "
            "decorator?"
        )
    return entity_library[entity_class_name]


def dump_to_dict(entity: Entity) -> dict:
    # Get entity class to ensure it's registered
    type_name = type(entity).__name__
    entity_class = get_entity_class_by_name(type_name)

    if not entity_class:
        raise Exception(
            f"Entity class {type_name} not found in entity "
            "library. Have you added the @entity_type decorator?"
        )

    entity_dict = entity.asdict()

    if "type_name" in entity_dict:
        raise Exception(
            "The type_name identifier is used in the serialization and is prohibited."
        )

    entity_dict["type_name"] = type_name
    return entity_dict


def dump_as_json(entity: Entity, ensure_ascii=False, **dump_kwargs):
    entity_dict = dump_to_dict(entity)
    json_str = json.dumps(entity_dict, ensure_ascii=False, **dump_kwargs)
    return json_str


def load_from_dict(entity_dict: dict):
    type_name = entity_dict.pop("type_name")
    cls = get_entity_class_by_name(type_name)

    if not cls:
        raise Exception(
            f"Entity class {type_name} not found in entity "
            "library. Have you added the @entity_type decorator?"
        )

    field_names = {a.name for a in attrs.fields(cls)}
    init_kwargs = {k: v for k, v in entity_dict.items() if k in field_names}
    return cls(**init_kwargs)


@entity_type
class Entity:
    """The base class for entities. Provides several convenience methods for
    conversions to and from dict, copying and attribute updates (via replace()).

    All entity subclasses should be decorated with @entity_type:

        @entity_type
        class EntitySubclass(Entity):
            ...

    Ids are used for hashing and equality checks, so they are frozen after
    creation. To change an id, produce a new entity via with_id().
    """

    id: str = attrs.field(factory=get_entity_id, on_setattr=attrs.setters.frozen)
    parent_id: str = ""

    def __hash__(self):
        return hash(self.id)

    def __eq__(self, other) -> bool:
        if not other:
            return False
        return self.id == other.id

    def __repr__(self) -> str:
        return f"<{type(self).__name__} id={self.id}>"

    def __copy__(self):
        return self.copy()

    def copy(self: _EntityT) -> _EntityT:
        self_copy = type(self)(**self.asdict())
        return self_copy  # type: ignore[return-value]

    def asdict(self) -> dict:
        """Return the entity fields as a dict (non-recursive, shallow copy
        of mutable values)."""
        self_dict = {
            a.name: getattr(self, a.name) for a in attrs.fields(type(self)) if a.repr
        }

        for key, val in self_dict.items():
            if isinstance(val, (list, dict, set)):
                val = val.copy()
                self_dict[key] = val

        return self_dict

    def replace(self, **changes):
        """Update entity fields using keyword arguments."""
        for key, val in changes.items():
            setattr(self, key, val)

    def change_from(self, other: "Entity"):
        """Compute a Change between self (old) and other (new).
        Granularity: level-1 entity properties. If a level-1 key's value
        has changed, the whole key is included in the delta."""
        from sivkit.storage.change import Change

        if self.id != other.id:
            raise ValueError("Cannot create change from entities with different IDs")

        old_state = dump_to_dict(self)
        new_state = dump_to_dict(other)

        reverse_delta = {}
        forward_delta = {}

        all_keys = set(old_state.keys()) | set(new_state.keys())
        for key in all_keys:
            old_val = old_state.get(key)
            new_val = new_state.get(key)
            if old_val != new_val:
                reverse_delta[key] = old_val
                forward_delta[key] = new_val

        return Change(self.id, reverse_delta, forward_delta)


def transformed_entity(entity: Entity, change) -> Entity:
    """Apply a Change's forward component to an entity, producing a new entity.
    Only works with UPDATE changes."""
    from sivkit.storage.change import ChangeTypes

    if entity.id != change.entity_id:
        raise ValueError("Cannot apply change from a different entity")
    if change.type() != ChangeTypes.UPDATE:
        raise ValueError("Can only apply UPDATE changes via transformed_entity")

    new_dict = {**dump_to_dict(entity), **change.forward_component}
    return load_from_dict(new_dict)
