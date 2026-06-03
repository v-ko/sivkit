import asyncio
import time
from typing import Callable, Optional


class MainLoop:
    """A main loop base class"""

    def call_delayed(
        self,
        callback: Callable,
        delay: float = 0,
        args: Optional[list] = None,
        kwargs: Optional[dict] = None,
    ):

        raise NotImplementedError

    def process_events(self):
        raise NotImplementedError


class NoMainLoop(MainLoop):
    """A MainLoop implementation that relies on calling process_events instead
    of actually initializing a main loop. Used mostly for testing."""

    def __init__(self):
        self.callback_stack = []

    def call_delayed(
        self,
        callback: Callable,
        delay: float = 0,
        args: Optional[list] = None,
        kwargs: Optional[dict] = None,
    ):

        args = args or []
        kwargs = kwargs or {}
        self.callback_stack.append((callback, time.time() + delay, args, kwargs))

    def process_events(self):
        callback_stack = self.callback_stack
        self.callback_stack = []
        for callback, call_time, args, kwargs in callback_stack:
            if time.time() >= call_time:
                callback(*args, **kwargs)

        if self.callback_stack:
            self.process_events()


_main_loop = NoMainLoop()


def set_main_loop(main_loop: MainLoop):
    """Swap the main loop that the module uses. That's needed in order to make
    the GUI swappable (and most frameworks have their own mechanisms).
    """
    global _main_loop
    _main_loop = main_loop


def main_loop() -> MainLoop:
    """Get the main loop object"""
    return _main_loop


class AsyncioMainLoop(MainLoop):
    """MainLoop backed by asyncio's event loop."""

    def __init__(self, loop: asyncio.AbstractEventLoop | None = None):
        try:
            self._loop = loop or asyncio.get_running_loop()
        except RuntimeError:
            self._loop = loop or asyncio.get_event_loop()

    def call_delayed(
        self,
        callback: Callable,
        delay: float = 0,
        args: Optional[list] = None,
        kwargs: Optional[dict] = None,
    ):
        args = args or []
        kwargs = kwargs or {}

        def _runner():
            try:
                callback(*args, **kwargs)
            except Exception as exc:  # noqa: BLE001
                from sivkit import main_loop_exception_handler

                main_loop_exception_handler(exc)

        if delay <= 0:
            self._loop.call_soon(_runner)
        else:
            self._loop.call_later(delay, _runner)

    def process_events(self):
        # asyncio loop drives itself
        pass
