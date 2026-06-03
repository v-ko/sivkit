import threading
from time import sleep
from typing import Callable

from PySide6.QtCore import QMetaObject, QObject, Qt, QTimer, Slot
from PySide6.QtWidgets import QApplication

from sivkit.loop import MainLoop
from sivkit.platform.qt_widgets.qt_event_loop import install


def _install_async_loop(app: QApplication) -> None:
    """Automatically install the Qt-async event loop when a QtMainLoop is created."""

    install(app)


class ProxyCall(QObject):

    def __init__(
        self, handler: callable, args: list = None, kwargs: dict = None
    ) -> None:
        super().__init__()
        self.handler = handler
        self.args = args or []
        self.kwargs = kwargs or {}

    @Slot()
    def invoke(self):
        self.handler(*self.args, **self.kwargs)


class QtMainLoop(MainLoop):

    def __init__(self, app: QApplication):
        self.app = app
        self.queue_checksum = 0
        self.tmp_proxies_list = []

        # Install Qt-integrated asyncio event loop so @procedure works
        _install_async_loop(app)

    def call_delayed(
        self,
        callback: Callable,
        delay: float = 0,
        args: list = None,
        kwargs: dict = None,
    ):

        args = args or []
        kwargs = kwargs or {}

        if not isinstance(callback, Callable):
            raise Exception

        def report_and_callback():
            self.queue_checksum -= 1
            callback(*args, **kwargs)

        self.queue_checksum += 1

        # lambda: callback(*args, **kwargs))
        if threading.current_thread() is threading.main_thread():
            QTimer.singleShot(delay * 1000, report_and_callback)
        else:
            # If we are not in the main thread, we need to use the proxy hack
            proxy = ProxyCall(report_and_callback)
            proxy.moveToThread(self.app.thread())
            self.tmp_proxies_list.append(proxy)
            success = QMetaObject.invokeMethod(proxy, "invoke", Qt.QueuedConnection)
            if not success:
                raise Exception("Failed to invoke method")

    def process_events(self, repeat: int = 0):
        # A hacky way to be sure that all posted events are called
        self.app.processEvents()  # QEventLoop.WaitForMoreEvents
        self.app.sendPostedEvents()
        if self.queue_checksum:
            self.process_events()

        if repeat:
            sleep(0.001)
            self.process_events(repeat=repeat - 1)

    def loop(self):
        self.app.exec()
