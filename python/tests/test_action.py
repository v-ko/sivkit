import pytest

from sivkit import Entity, entity_type
from sivkit.libs.action import (
    ActionRunStates,
    _action_call_stack,
    _changes_registrations,
    _root_action_completed_hooks,
    _root_action_started_hooks,
    action,
    check_in_action,
    is_in_action,
    register_root_action_changes_handler,
    register_root_action_completed_hook,
    register_root_action_started_hook,
)
from sivkit.libs.model import dump_to_dict
from sivkit.libs.projection import _projections, is_in_projection, register_projection
from sivkit.storage.change import Change
from sivkit.storage.delta import Delta
from sivkit.storage.in_memory_store import InMemoryStore
from sivkit.storage.websocket_sync_service import WebSocketSyncService


def _clear_action_state():
    _action_call_stack.clear()
    _root_action_started_hooks.clear()
    _root_action_completed_hooks.clear()
    _changes_registrations.clear()
    _projections.clear()


@pytest.fixture(autouse=True)
def action_state():
    _clear_action_state()
    try:
        yield
    finally:
        _clear_action_state()


@pytest.mark.parametrize(
    "options,issuer",
    [({}, "user"), ({"issuer": "service"}, "service")],
    ids=["default issuer", "custom issuer"],
)
def test_action_returns_value_and_reports_completed_state(options, issuer):
    received = []
    register_root_action_completed_hook(lambda s: received.append(s))

    @action("test.add", **options)
    def add(a, b):
        return a + b

    assert add(2, 3) == 5
    assert len(received) == 1
    assert received[0].issuer == issuer
    assert received[0].name == f"[{issuer}]test.add"
    assert received[0].run_state == ActionRunStates.COMPLETED
    assert received[0].duration >= 0
    assert _action_call_stack == []


def test_nested_actions_only_fire_root_hooks():
    started = []
    completed = []
    register_root_action_started_hook(lambda s: started.append(s.name))
    register_root_action_completed_hook(lambda s: completed.append(s.name))

    @action("test.inner")
    def inner():
        return 42

    @action("test.outer")
    def outer():
        return inner()

    result = outer()
    assert result == 42
    # Only root action triggers hooks
    assert len(started) == 1
    assert started[0] == "[user]test.outer"
    assert len(completed) == 1
    assert completed[0] == "[user]test.outer"
    assert _action_call_stack == []


def test_exception_sets_failed_and_reraises():
    completed = []
    register_root_action_completed_hook(lambda s: completed.append(s))

    @action("test.failing")
    def failing():
        raise ValueError("boom")

    with pytest.raises(ValueError, match="boom"):
        failing()

    assert len(completed) == 1
    assert completed[0].run_state == ActionRunStates.FAILED
    assert _action_call_stack == []


def test_nested_error_propagates_and_root_hooks_fire():
    completed = []
    register_root_action_completed_hook(lambda s: completed.append(s))

    @action("test.inner_fail")
    def inner():
        raise ValueError("inner boom")

    @action("test.outer_fail")
    def outer():
        inner()

    with pytest.raises(ValueError, match="inner boom"):
        outer()

    # Root completed hook fires (with FAILED state)
    assert len(completed) == 1
    assert completed[0].run_state == ActionRunStates.FAILED
    assert len(_action_call_stack) == 0


def test_action_scope_and_mutation_guard():
    assert is_in_action() is False
    with pytest.raises(Exception, match="@action"):
        check_in_action()

    @action("test.guard_inside")
    def guarded():
        assert is_in_action() is True
        check_in_action()

    guarded()
    assert is_in_action() is False
    with pytest.raises(Exception, match="@action"):
        check_in_action()


def test_started_before_body_completed_after():
    events = []
    register_root_action_started_hook(lambda s: events.append("started"))
    register_root_action_completed_hook(lambda s: events.append("completed"))

    @action("test.ordering")
    def body():
        events.append("body")

    body()
    assert events == ["started", "body", "completed"]


@entity_type
class _ActionTestEntity(Entity):
    name: str = ""


def _create_delta(entity):
    return Delta.from_changes([Change(entity.id, {}, dump_to_dict(entity))])


def test_root_action_changes_handler():
    store = InMemoryStore()
    calls, other, fired = [], [], []
    unregister = register_root_action_changes_handler(
        store, lambda root, changes: calls.append((root, changes))
    )
    unregister_other = register_root_action_changes_handler(
        store, lambda root, changes: other.append(changes)
    )
    store.add_on_changes_callback(lambda d, o: fired.append(d))
    a, b = _ActionTestEntity(), _ActionTestEntity()

    # Outside an action: raises before altering the store; load_data is exempt
    with pytest.raises(Exception, match="@action"):
        store.insert_one(a)
    with pytest.raises(Exception, match="@action"):
        store.apply_delta(_create_delta(a))
    assert store.find_one(id=a.id) is None and fired == []
    store.load_data([_ActionTestEntity()])

    @action("test.inner", issuer="service")
    def inner():
        store.insert_one(a)

    @action("test.outer")
    def outer():
        inner()
        store.apply_delta(_create_delta(b), origin="remote")

    @action("test.noop")
    def noop():
        pass

    outer()
    noop()
    root, changes = calls[0]
    assert root.name == "[user]test.outer"
    assert [(c.action.name, c.origin) for c in changes] == [
        ("[service]test.inner", None),
        ("[user]test.outer", "remote"),
    ]
    assert changes[1].delta.change(b.id).is_create()
    assert calls[1][1] == [] and len(other) == 2

    unregister_other()
    assert store.require_action is True
    unregister()
    assert store.require_action is False
    noop()
    store.insert_one(_ActionTestEntity())
    assert len(calls) == 2


def test_throwing_callback_rolls_back_and_earlier_callbacks_see_the_revert():
    store = InMemoryStore()
    calls = []
    register_root_action_changes_handler(
        store, lambda root, changes: calls.append((root, changes))
    )

    def _boom(_d, _o):
        raise RuntimeError("listener failed")

    store.add_on_changes_callback(_boom)
    entity = _ActionTestEntity()

    @action("test.rolled_back")
    def insert():
        store.insert_one(entity)

    with pytest.raises(RuntimeError):
        insert()
    assert store.find_one(id=entity.id) is None
    root, changes = calls[0]
    merged = Delta()
    for c in changes:
        merged.merge_with_priority(c.delta.copy())
    assert merged.change(entity.id) is None
    assert root.run_state == ActionRunStates.FAILED


def test_projection():
    store = InMemoryStore()
    projected = []

    def projector(delta, projected_store):
        assert is_in_projection() and projected_store is store
        projected.append(delta)

    unregister = register_projection(store, projector)
    with pytest.raises(Exception, match="already registered"):
        register_projection(store, lambda d, s: None)
    a, b = _ActionTestEntity(), _ActionTestEntity()

    @action("test.insert_two")
    def insert_two():
        store.insert_one(a)
        store.insert_one(b)

    @action("test.noop")
    def noop():
        pass

    insert_two()
    noop()
    assert sorted(projected[0].entity_ids()) == sorted([a.id, b.id])
    assert projected[1].is_empty()

    unregister()
    register_projection(store, lambda d, s: None)


def test_sync_remote_apply_is_in_action_only_when_required():
    store = InMemoryStore()
    service = WebSocketSyncService(store, role="receiver")
    first = _ActionTestEntity()
    service._apply_remote(_create_delta(first))
    assert store.find_one(id=first.id) is not None

    roots = []
    register_root_action_changes_handler(
        store, lambda root, changes: roots.append(root)
    )
    second = _ActionTestEntity()
    service._apply_remote(_create_delta(second))
    assert store.find_one(id=second.id) is not None
    assert [r.name for r in roots] == ["[service]sync.apply_remote_delta"]
