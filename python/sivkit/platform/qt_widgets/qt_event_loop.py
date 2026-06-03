"""Minimal asyncio event loop integration with Qt.

Provides QtAsyncEventLoop — an asyncio-compatible event loop that runs
inside Qt's event loop on the main thread.  Scheduling uses QTimer,
I/O readiness uses QSocketNotifier, and thread-safe callbacks use Qt
signals.

This gives async/await support on the Qt main thread without any
third-party dependency.  Procedures (async functions) can freely read
Qt state, call actions, and await I/O — all single-threaded, same as
JavaScript.

Usage::

    from PySide6.QtWidgets import QApplication
    from sivkit.platform.qt_widgets.qt_event_loop import install

    app = QApplication(sys.argv)
    loop = install(app)      # async/await now works on the main thread
    # ... set up UI ...
    sys.exit(app.exec())     # QTimers drive asyncio callbacks
"""

from __future__ import annotations

import asyncio
import asyncio.events
import inspect
import time
from typing import Optional

from PySide6.QtCore import QObject, QSocketNotifier, Signal, Slot
from PySide6.QtWidgets import QApplication

from sivkit.logging import get_logger

log = get_logger(__name__)


def _fileno(fd) -> int:
    """Extract integer file descriptor from fd-like object."""
    if isinstance(fd, int):
        return fd
    return int(fd.fileno())


# ---------------------------------------------------------------------------
# Qt helper objects
# ---------------------------------------------------------------------------


class _Signaller(QObject):
    """Emits a Qt signal so call_soon_threadsafe can cross threads safely."""

    signal = Signal(object, tuple)


class _TimerManager(QObject):
    """Executes asyncio.Handle callbacks via Qt's timer mechanism.

    Each callback is registered as a one-shot QTimer (startTimer).
    When the timer fires, the handle is executed and the timer killed.
    """

    def __init__(self, parent: Optional[QObject] = None):
        super().__init__(parent)
        self._handles: dict[int, asyncio.Handle] = {}

    def add_callback(self, handle: asyncio.Handle, delay: float = 0) -> asyncio.Handle:
        ms = int(max(0, delay) * 1000)
        timer_id = self.startTimer(ms)
        self._handles[timer_id] = handle
        return handle

    def timerEvent(self, event):  # noqa: N802 — Qt naming
        timer_id = event.timerId()
        self.killTimer(timer_id)
        handle = self._handles.pop(timer_id, None)
        if handle is not None and not handle._cancelled:
            handle._run()

    def stop(self):
        for timer_id in list(self._handles):
            self.killTimer(timer_id)
        self._handles.clear()


# ---------------------------------------------------------------------------
# The event loop
# ---------------------------------------------------------------------------


class QtAsyncEventLoop(asyncio.SelectorEventLoop):
    """asyncio event loop that delegates scheduling and I/O to Qt.

    All asyncio callbacks run on the Qt main thread.

    * ``call_soon`` / ``call_later`` → QTimer one-shots
    * ``_add_reader`` / ``_add_writer`` → QSocketNotifier
    * ``call_soon_threadsafe`` → Qt signal
    * ``run_forever`` → ``app.exec()``
    """

    def __init__(
        self,
        app: Optional[QApplication] = None,
        already_running: bool = False,
    ):
        self.__app = app or QApplication.instance()
        if self.__app is None:
            raise RuntimeError("No QApplication instance available")

        self.__is_running = False

        # Callback scheduler
        self._qt_timer = _TimerManager()

        # Thread-safe signaller
        self._signaller = _Signaller()
        self._call_soon_signal = self._signaller.signal
        self._call_soon_signal.connect(self._on_threadsafe_callback)

        # I/O notifiers
        self._qt_read_notifiers: dict[int, QSocketNotifier] = {}
        self._qt_write_notifiers: dict[int, QSocketNotifier] = {}

        super().__init__()

        if already_running:
            self.__is_running = True
            asyncio.events._set_running_loop(self)
            self.__app.aboutToQuit.connect(self._on_app_quit)

    # -- thread-safe signal handler --

    @Slot(object, tuple)
    def _on_threadsafe_callback(self, callback, args):
        self.call_soon(callback, *args)

    # ----------------------------------------------------------------
    # Scheduling overrides
    # ----------------------------------------------------------------

    def call_later(self, delay, callback, *args, context=None):
        if inspect.iscoroutinefunction(callback):
            raise TypeError("coroutines cannot be used with call_later")
        if not callable(callback):
            raise TypeError(f"callback must be callable: {type(callback).__name__}")
        handle = asyncio.Handle(callback, args, self, context=context)
        self._qt_timer.add_callback(handle, delay)
        return handle

    def call_soon(self, callback, *args, context=None):
        return self.call_later(0, callback, *args, context=context)

    def call_at(self, when, callback, *args, context=None):
        return self.call_later(when - self.time(), callback, *args, context=context)

    def time(self):
        return time.monotonic()

    def call_soon_threadsafe(self, callback, *args, context=None):
        self._call_soon_signal.emit(callback, args)

    # ----------------------------------------------------------------
    # I/O overrides (QSocketNotifier replaces select/poll)
    # ----------------------------------------------------------------

    def _add_reader(self, fd, callback, *args):
        if fd in self._qt_read_notifiers:
            self._remove_reader(fd)
        fileno = _fileno(fd)
        notifier = QSocketNotifier(fileno, QSocketNotifier.Type.Read)
        notifier.setEnabled(True)

        def _on_ready():
            notifier.setEnabled(False)
            if fd in self._qt_read_notifiers:
                callback(*args)
                # Re-enable if the notifier wasn't removed by the callback
                if fd in self._qt_read_notifiers:
                    notifier.setEnabled(True)

        notifier.activated.connect(_on_ready)
        self._qt_read_notifiers[fd] = notifier

    def _remove_reader(self, fd):
        notifier = self._qt_read_notifiers.pop(fd, None)
        if notifier is None:
            return False
        notifier.setEnabled(False)
        try:
            notifier.activated.disconnect()
        except Exception:
            pass
        notifier.deleteLater()
        return True

    def _add_writer(self, fd, callback, *args):
        if fd in self._qt_write_notifiers:
            self._remove_writer(fd)
        fileno = _fileno(fd)
        notifier = QSocketNotifier(fileno, QSocketNotifier.Type.Write)
        notifier.setEnabled(True)

        def _on_ready():
            notifier.setEnabled(False)
            if fd in self._qt_write_notifiers:
                callback(*args)
                if fd in self._qt_write_notifiers:
                    notifier.setEnabled(True)

        notifier.activated.connect(_on_ready)
        self._qt_write_notifiers[fd] = notifier

    def _remove_writer(self, fd):
        notifier = self._qt_write_notifiers.pop(fd, None)
        if notifier is None:
            return False
        notifier.setEnabled(False)
        try:
            notifier.activated.disconnect()
        except Exception:
            pass
        notifier.deleteLater()
        return True

    # ----------------------------------------------------------------
    # Lifecycle
    # ----------------------------------------------------------------

    def run_forever(self):
        if self.__is_running:
            raise RuntimeError("Event loop already running")
        self.__is_running = True
        asyncio.events._set_running_loop(self)
        try:
            if hasattr(self.__app, "exec"):
                return self.__app.exec()
            return self.__app.exec_()
        finally:
            asyncio.events._set_running_loop(None)
            self.__is_running = False

    def stop(self):
        if not self.__is_running:
            return
        self.__is_running = False
        self.__app.exit()

    def is_running(self):
        return self.__is_running

    def is_closed(self):
        return self.__app is None

    def close(self):
        if self.is_running():
            raise RuntimeError("Cannot close a running event loop")
        if self.is_closed():
            return
        self._qt_timer.stop()
        for fd in list(self._qt_read_notifiers):
            self._remove_reader(fd)
        for fd in list(self._qt_write_notifiers):
            self._remove_writer(fd)
        try:
            self._signaller.deleteLater()
        except Exception:
            pass
        super().close()
        self.__app = None

    def _on_app_quit(self):
        """Clean up when QApplication is about to quit."""
        self.__is_running = False
        asyncio.events._set_running_loop(None)

    # ----------------------------------------------------------------
    # Error handling
    # ----------------------------------------------------------------

    def default_exception_handler(self, context):
        message = context.get("message", "Unhandled exception in event loop")
        exception = context.get("exception")
        if exception:
            log.error(message, exc_info=exception)
        else:
            log.error(message)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

_installed_loop: Optional[QtAsyncEventLoop] = None


def install(app: Optional[QApplication] = None) -> QtAsyncEventLoop:
    """Create and install a Qt-integrated asyncio event loop.

    Call after QApplication is created.  The loop is registered as the
    default asyncio event loop and marked as already running.  Coroutines
    scheduled via ``asyncio.create_task()`` or ``ensure_future()`` will
    run on the Qt main thread, driven by QTimer callbacks inside
    ``app.exec()``.

    Returns the installed loop.
    """
    global _installed_loop
    if _installed_loop is not None:
        return _installed_loop

    loop = QtAsyncEventLoop(app, already_running=True)
    asyncio.set_event_loop(loop)
    _installed_loop = loop
    log.info("Qt-async event loop installed")
    return loop


def get_loop() -> Optional[QtAsyncEventLoop]:
    """Return the installed Qt-async loop, or None."""
    return _installed_loop
