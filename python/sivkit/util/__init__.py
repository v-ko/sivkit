from __future__ import annotations

import random
import re
import uuid
from collections.abc import Iterable, Mapping
from contextlib import contextmanager
from datetime import datetime
from hashlib import md5
from typing import Any, Generator

from .color import Color
from .point2d import Point2D
from .rectangle import Rectangle

_fake_time = None


@contextmanager
def fake_time(time: datetime):
    global _fake_time

    if time.tzinfo is None:
        raise Exception

    _fake_time = time
    yield
    _fake_time = None


def current_time() -> datetime:
    if _fake_time:  # For testing purposes
        return _fake_time

    return datetime.now().astimezone()


def timestamp(dt: datetime, microseconds: bool = False):
    if dt.tzinfo is None:  # If no timezone is set - assume local
        dt = dt.astimezone()
    if microseconds:
        return dt.isoformat()
    else:
        return dt.isoformat(timespec="seconds")


def get_new_id(seed=None) -> str:
    """Get a random id"""
    if seed:
        return md5(str(seed).encode("utf-8")).hexdigest()[-8:]
    guid = str(uuid.UUID(int=random.getrandbits(128)))[-8:]
    return guid


def verify_id_format(id: str) -> bool:
    """Verify that the given id is in the correct format"""
    # Lower case ascii letters and numbers only
    if not id:
        return False
    expression = r"^[a-z0-9-]+$"
    return bool(re.match(expression, id))


def find_many_by_props(
    item_list: Iterable[Any] | Mapping[Any, Any], **props: Any
) -> Generator[Any, None, None]:
    """Filter an iterable or mapping and return only objets which have attributes
    matching the provided keyword arguments (key==attr_name and val==attr_val)
    """
    if isinstance(item_list, Mapping):
        item_list = item_list.values()
    elif isinstance(item_list, Iterable):
        pass
    else:
        raise ValueError

    for item in item_list:
        skip = False
        for key, value in props.items():
            if not hasattr(item, key):
                skip = True
                continue

            if getattr(item, key) != value:
                skip = True

        if not skip:
            yield item


def find_one_by_props(
    item_list: Iterable[Any] | Mapping[Any, Any], **props: Any
) -> Any:
    """Convenience method to filter for one object in an iterable or mapping with
    attributes matching the given keyword arguments.
    """
    items_found = list(find_many_by_props(item_list, **props))

    if not items_found:
        return None

    return items_found[0]


def deep_merge(base: Mapping[str, Any], overrides: Mapping[str, Any]) -> dict:
    """Return a new dict = ``base`` recursively overlaid with ``overrides``.

    - dict-on-dict merges recursively;
    - everything else (lists, scalars, ``None``) replaces the base value;
    - keys present only in ``base`` are preserved;
    - inputs are not mutated.

    Note: ``None`` in ``overrides`` is a value, not a delete marker — some
    settings legitimately accept ``None``. Use explicit removal at the call
    site if you need delete semantics.
    """
    result: dict = dict(base)
    for key, override_value in overrides.items():
        base_value = result.get(key)
        if isinstance(base_value, Mapping) and isinstance(override_value, Mapping):
            result[key] = deep_merge(base_value, override_value)
        else:
            result[key] = override_value
    return result
