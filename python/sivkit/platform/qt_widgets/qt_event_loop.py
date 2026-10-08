"""asyncio integration with Qt's event loop, backed by qasync.

qasync (https://github.com/CabbageDevelopment/qasync) provides an asyncio
event loop that runs inside Qt's event loop on the main thread: QTimer for
scheduling, QSocketNotifier for I/O readiness on Unix, IOCP (proactor) on
Windows, and a Qt signal for ``call_soon_threadsafe``.  Procedures (async
functions) can freely read Qt state, call actions, and await I/O — all
single-threaded, same as JavaScript.

sivkit installs the loop in "already running" mode, so apps keep calling
``app.exec()`` themselves.

Usage::

    from PySide6.QtWidgets import QApplication
    from sivkit.platform.qt_widgets.qt_event_loop import install

    app = QApplication(sys.argv)
    loop = install(app)      # async/await now works on the main thread
    # ... set up UI ...
    sys.exit(app.exec())     # Qt drives the asyncio callbacks
"""

from __future__ import annotations

import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

import qasync
from PySide6.QtWidgets import QApplication

log = logging.getLogger(__name__)

_installed_loop: Optional[qasync.QEventLoop] = None


def install(app: Optional[QApplication] = None) -> qasync.QEventLoop:
    """Create and install a Qt-integrated asyncio event loop.

    Call after QApplication is created.  The loop is registered as the
    default asyncio event loop and marked as already running.  Coroutines
    scheduled via ``asyncio.create_task()`` or ``ensure_future()`` will
    run on the Qt main thread, driven by ``app.exec()``.

    Returns the installed loop.
    """
    global _installed_loop
    if _installed_loop is not None:
        return _installed_loop

    loop = qasync.QEventLoop(app or QApplication.instance(), already_running=True)
    # qasync's default executor is a pool of QThreads that must be shut down
    # by loop.close(), which apps don't call (they just return from
    # app.exec()), so Qt aborts at exit. Use asyncio's usual thread pool.
    loop.set_default_executor(ThreadPoolExecutor(thread_name_prefix="asyncio"))
    asyncio.set_event_loop(loop)
    _installed_loop = loop
    log.info("Qt-async event loop installed")
    return loop


def uninstall() -> None:
    """Undo ``install()`` after ``app.exec()`` has returned (for tests)."""
    global _installed_loop
    loop = _installed_loop
    if loop is None:
        return
    _installed_loop = None
    asyncio.events._set_running_loop(None)
    asyncio.set_event_loop(None)
    loop.stop()
    loop.close()


def get_loop() -> Optional[qasync.QEventLoop]:
    """Return the installed Qt-async loop, or None."""
    return _installed_loop
