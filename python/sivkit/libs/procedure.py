"""The ``@procedure`` decorator — async counterpart to ``@action``.

Actions are synchronous functions that mutate state on the Qt main thread.
Procedures are async functions that orchestrate work (I/O, delays, waiting
for results) — also on the Qt main thread.

    @action('update_overlay')
    def update_overlay(shapes): ...      # sync, immediate

    @procedure
    async def run_experiment():           # async, scheduled as a Task
        shapes = await detect_shapes()
        update_overlay(shapes)

Calling a ``@procedure``-decorated function immediately schedules the
coroutine on the running asyncio event loop and returns the ``Task``.
The task is already started — no explicit ``create_task`` needed.
"""

from __future__ import annotations

import asyncio
import functools
import inspect
import logging
from typing import Any, Callable, Coroutine, Self

log = logging.getLogger(__name__)


class Task(asyncio.Task):
    """Task subclass with fluent Promise-like error handling.

    Usage::

        fetch_data(url) \\
            .then(lambda result: update_ui(result)) \\
            .catch(lambda exc: log.error("Failed: %s", exc)) \\
            .on_cancel(lambda: log.warning("Cancelled")) \\
            .finally_(lambda: spinner.hide())
    """

    def then(self, on_result: Callable[[Any], Any]) -> Self:
        """Called with the return value when the task succeeds."""

        def _done(t: asyncio.Task) -> None:
            if t.cancelled():
                return
            if t.exception() is not None:
                return
            on_result(t.result())

        self.add_done_callback(_done)
        return self

    def catch(self, on_exception: Callable[[Exception], Any]) -> Self:
        """Called with the exception when the task fails (not on cancel)."""

        def _done(t: asyncio.Task) -> None:
            if t.cancelled():
                return
            exc = t.exception()
            if exc is not None:
                on_exception(exc)

        self.add_done_callback(_done)
        return self

    def on_cancel(self, callback: Callable[[], Any]) -> Self:
        """Called when the task is cancelled."""

        def _done(t: asyncio.Task) -> None:
            if t.cancelled():
                callback()

        self.add_done_callback(_done)
        return self

    def finally_(self, callback: Callable[[], Any]) -> Self:
        """Called regardless of outcome (success, exception, or cancel)."""

        def _done(t: asyncio.Task) -> None:
            callback()

        self.add_done_callback(_done)
        return self


def procedure(fn: Callable[..., Any]) -> Callable[..., Task]:
    """Decorator: auto-schedule an async function as an asyncio Task.

    When called, the coroutine is immediately scheduled on the running
    event loop and the Task is returned.  Can be awaited from async code
    or used fire-and-forget from synchronous Qt slots.

    Clients are expected to define their own exception handling.
    """
    if not inspect.iscoroutinefunction(fn):
        raise TypeError(f"@procedure can only decorate async functions, got {fn!r}")

    @functools.wraps(fn)
    def wrapper(*args, **kwargs) -> Task:
        coro = fn(*args, **kwargs)
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            raise RuntimeError(
                "No running asyncio event loop. "
                "Ensure sivkit.platform.qt_widgets.qt_event_loop.install() "
                "has been called."
            ) from None
        task = Task(coro, loop=loop, name=fn.__qualname__)
        return task

    wrapper._is_procedure = True
    return wrapper
