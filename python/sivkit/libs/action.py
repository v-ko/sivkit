import functools
import logging
import time
from enum import Enum
from typing import Callable

log = logging.getLogger(__name__)


class ActionRunStates(Enum):
    NOT_STARTED = "NOT_STARTED"
    STARTED = "STARTED"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"


class ActionState:
    """Carries the state of a single action invocation.
    Matches the TS ActionState class in sivkit/registries/Action.ts.
    """

    def __init__(self, name: str):
        self.name = name
        self.run_state = ActionRunStates.NOT_STARTED
        self.start_time: float = 0
        self.duration: float = 0

    @property
    def issuer(self) -> str:
        """Parse issuer from name format '[issuer]method_name'."""
        return self.name.split("]")[0].replace("[", "")

    @property
    def started(self) -> bool:
        return self.run_state == ActionRunStates.STARTED

    @property
    def completed(self) -> bool:
        return self.run_state == ActionRunStates.COMPLETED

    def set_started(self):
        self.run_state = ActionRunStates.STARTED
        self.start_time = time.time()

    def set_completed(self):
        self.run_state = ActionRunStates.COMPLETED
        self.duration = time.time() - self.start_time

    def copy(self) -> "ActionState":
        c = ActionState(self.name)
        c.run_state = self.run_state
        c.start_time = self.start_time
        c.duration = self.duration
        return c

    def __repr__(self):
        return (
            f"<ActionState name={self.name} "
            f"run_state={self.run_state.value} "
            f"duration={self.duration * 1000:.2f}ms>"
        )


# Global action call stack to track nesting (matches TS _actionCallStack)
_action_call_stack: list[ActionState] = []

# Synchronous hook lists (matches TS _rootActionStartedHooks/_rootActionCompletedHooks)
_root_action_started_hooks: list[Callable] = []
_root_action_completed_hooks: list[Callable] = []


def register_root_action_started_hook(hook: Callable):
    log.info("register_root_action_started_hook called")
    _root_action_started_hooks.append(hook)


def register_root_action_completed_hook(hook: Callable):
    log.info("register_root_action_completed_hook called")
    _root_action_completed_hooks.append(hook)


def is_in_action() -> bool:
    return bool(_action_call_stack)


def check_in_action():
    """Guard for view state mutations — raises if not inside an @action."""
    if not is_in_action():
        raise Exception(
            "State changes can only happen in functions decorated with "
            "the @action decorator"
        )


def action(name: str, issuer: str = "user"):
    """Decorator that wraps a function as an action with call-stack tracking
    and synchronous root-action hooks.

    Matches the TS processMethod() flow in Action.ts.

    Args:
        name: The action name (e.g. 'window.close_tab')
        issuer: Origin of the action ('user' or 'service')
    """
    if not name or not isinstance(name, str):
        raise Exception(
            "Please add the action name as an argument to the decorator. "
            "E.g. @action('action_name')"
        )

    func_name = f"[{issuer}]{name}"

    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            # Create action state and mark started
            action_state = ActionState(func_name)
            action_state.set_started()

            # If root action — fire started hooks synchronously
            if len(_action_call_stack) == 0:
                for hook in _root_action_started_hooks:
                    hook(action_state)

            _action_call_stack.append(action_state)

            # Call the original function
            exception = None
            result = None
            try:
                result = func(*args, **kwargs)
            except Exception as e:
                log.error(f"Error in action {func_name}: {e}")
                exception = e

            if exception:
                action_state.run_state = ActionRunStates.FAILED

            # Pop and complete
            _action_call_stack.pop()
            if action_state.run_state != ActionRunStates.FAILED:
                action_state.set_completed()
            else:
                action_state.duration = time.time() - action_state.start_time

            # If root action — fire completed hooks synchronously
            if len(_action_call_stack) == 0:
                for hook in _root_action_completed_hooks:
                    hook(action_state)

            if exception:
                raise exception

            return result

        return wrapper

    return decorator
