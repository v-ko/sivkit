"""Projection library: projectors are functions that translate domain store changes into
view state changes.

Projection view states are managed objects within the view state (which can otherwise be
altered in actions). They are created, updated, and deleted by the projection function,
which takes in domain store changes from the actions.
"""

from typing import TYPE_CHECKING, Callable

from sivkit.libs.action import register_root_action_changes_handler
from sivkit.storage.delta import Delta

if TYPE_CHECKING:
    from sivkit.storage.base_store import Store

Projector = Callable[[Delta, Store], None]

# Projectors track their own scope rather than piggybacking on the action stack.
_in_projection = False
_projections: dict[int, Callable[[], None]] = {}


def is_in_projection() -> bool:
    return _in_projection


def assert_is_in_projection() -> None:
    # An assert so it's strippable via -O/PYTHONOPTIMIZE in prod.
    assert (
        _in_projection
    ), "Projection-managed view state can only be mutated inside a projector"


def run_in_projection(fn: Callable):
    """Run fn within projection scope."""
    global _in_projection
    was_in_projection = _in_projection
    _in_projection = True
    try:
        return fn()
    finally:
        _in_projection = was_in_projection


def register_projection(store: Store, projector: Projector) -> Callable[[], None]:
    """Register the store's projector (one per store).

    At each root action's end the projector gets the action's store changes
    merged into one delta (possibly empty) and the store, inside projection
    scope. Returns an unregister function.
    """
    key = id(store)
    if key in _projections:
        raise Exception("A projection is already registered for this store")

    def handler(_root_action, changes) -> None:
        delta = Delta()
        for change in changes:
            delta.merge_with_priority(change.delta.copy())
        run_in_projection(lambda: projector(delta, store))

    unregister_handler = register_root_action_changes_handler(store, handler)

    def unregister() -> None:
        unregister_handler()
        del _projections[key]

    _projections[key] = unregister
    return unregister


class ProjectedViewState:
    """Base for view state whose contents are written only by the projector.

    For slices of the view state which reflect domain store state.
    """

    def __init__(self) -> None:
        assert_is_in_projection()
