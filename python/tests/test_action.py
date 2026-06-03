import pytest

from sivkit.libs.action import (
    ActionRunStates,
    _action_call_stack,
    _root_action_completed_hooks,
    _root_action_started_hooks,
    action,
    check_in_action,
    is_in_action,
    register_root_action_completed_hook,
    register_root_action_started_hook,
)


def _clear_action_state():
    _action_call_stack.clear()
    _root_action_started_hooks.clear()
    _root_action_completed_hooks.clear()


def test_action_runs_and_returns_value():
    _clear_action_state()

    @action("test.basic")
    def add(a, b):
        return a + b

    assert add(2, 3) == 5


def test_default_issuer_is_user():
    _clear_action_state()
    received = []
    register_root_action_completed_hook(lambda s: received.append(s))

    @action("test.issuer_default")
    def noop():
        pass

    noop()
    assert received[0].issuer == "user"


def test_custom_issuer():
    _clear_action_state()
    received = []
    register_root_action_completed_hook(lambda s: received.append(s))

    @action("test.issuer_custom", issuer="service")
    def noop():
        pass

    noop()
    assert received[0].issuer == "service"


def test_action_state_is_completed():
    _clear_action_state()
    received = []
    register_root_action_completed_hook(lambda s: received.append(s))

    @action("test.completed")
    def noop():
        pass

    noop()
    assert received[0].run_state == ActionRunStates.COMPLETED
    assert received[0].duration >= 0


def test_issuer_parsed_from_name():
    _clear_action_state()
    received = []
    register_root_action_completed_hook(lambda s: received.append(s))

    @action("test.name_check", issuer="myservice")
    def noop():
        pass

    noop()
    assert received[0].name == "[myservice]test.name_check"
    assert received[0].issuer == "myservice"


def test_nested_actions_only_fire_root_hooks():
    _clear_action_state()
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


def test_stack_is_empty_after_nested_call():
    _clear_action_state()

    @action("test.inner2")
    def inner():
        pass

    @action("test.outer2")
    def outer():
        inner()

    outer()
    assert len(_action_call_stack) == 0


def test_exception_sets_failed_and_reraises():
    _clear_action_state()
    completed = []
    register_root_action_completed_hook(lambda s: completed.append(s))

    @action("test.failing")
    def failing():
        raise ValueError("boom")

    with pytest.raises(ValueError, match="boom"):
        failing()

    assert len(completed) == 1
    assert completed[0].run_state == ActionRunStates.FAILED


def test_stack_is_clean_after_error():
    _clear_action_state()

    @action("test.failing2")
    def failing():
        raise RuntimeError("oops")

    with pytest.raises(RuntimeError):
        failing()

    assert len(_action_call_stack) == 0


def test_nested_error_propagates_and_root_hooks_fire():
    _clear_action_state()
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


def test_is_in_action_false_outside():
    _clear_action_state()
    assert is_in_action() is False


def test_is_in_action_true_inside():
    _clear_action_state()
    observed = []

    @action("test.check_inside")
    def check():
        observed.append(is_in_action())

    check()
    assert observed == [True]


def test_check_in_action_raises_outside():
    _clear_action_state()
    with pytest.raises(Exception, match="@action"):
        check_in_action()


def test_check_in_action_passes_inside():
    _clear_action_state()

    @action("test.guard_inside")
    def guarded():
        check_in_action()  # should not raise

    guarded()  # no exception


def test_started_before_body_completed_after():
    _clear_action_state()
    events = []
    register_root_action_started_hook(lambda s: events.append("started"))
    register_root_action_completed_hook(lambda s: events.append("completed"))

    @action("test.ordering")
    def body():
        events.append("body")

    body()
    assert events == ["started", "body", "completed"]
