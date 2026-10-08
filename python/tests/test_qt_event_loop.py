import asyncio
import os
import threading

import pytest
from PySide6.QtCore import QTimer
from PySide6.QtWidgets import QApplication

from sivkit.libs.procedure import procedure
from sivkit.platform.qt_widgets.qt_event_loop import get_loop, install, uninstall
from sivkit.platform.qt_widgets.qt_main_loop import QtMainLoop


@pytest.fixture
def qt_app():
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    app = QApplication.instance() or QApplication([])
    yield app
    uninstall()


def test_qt_main_loop_drives_asyncio(qt_app):
    main_loop = QtMainLoop(qt_app)
    loop = install(qt_app)
    assert get_loop() is loop
    assert asyncio.get_event_loop() is loop
    main_thread = threading.main_thread()

    @procedure
    async def add_one(x):
        await asyncio.sleep(0.01)
        return x + 1

    async def check():
        assert asyncio.get_running_loop() is loop
        assert await add_one(1) == 2

        ran_on = loop.create_future()
        threading.Thread(
            target=main_loop.call_delayed,
            args=(lambda: ran_on.set_result(threading.current_thread()),),
        ).start()
        assert await asyncio.wait_for(ran_on, 5) is main_thread

        # asyncio's thread pool, not qasync's QThreads (those abort Qt at exit)
        name = await asyncio.to_thread(lambda: threading.current_thread().name)
        assert name.startswith("asyncio")

    task = loop.create_task(check())
    task.add_done_callback(lambda _: qt_app.quit())
    QTimer.singleShot(10_000, lambda: qt_app.exit(2))  # hang guard
    assert qt_app.exec() == 0
    task.result()
