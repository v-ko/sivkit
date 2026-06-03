import asyncio
import time

import pytest

from sivkit.loop import AsyncioMainLoop, NoMainLoop


def test_no_main_loop_immediate():
    loop = NoMainLoop()
    executed: list[str] = []

    loop.call_delayed(lambda: executed.append("immediate"))
    loop.process_events()

    assert executed == ["immediate"]


def test_no_main_loop_delayed():
    loop = NoMainLoop()
    executed: list[str] = []

    loop.call_delayed(lambda: executed.append("delayed"), delay=0.3)
    # Wait long enough for delay to elapse
    time.sleep(0.5)
    loop.process_events()

    assert executed == ["delayed"]


@pytest.mark.asyncio
async def test_asyncio_main_loop_immediate_and_delayed():
    executed: list[str] = []

    ml = AsyncioMainLoop()
    ml.call_delayed(lambda: executed.append("immediate"))
    ml.call_delayed(lambda: executed.append("delayed"), delay=0.3)

    # Allow immediate callback to run
    await asyncio.sleep(0)  # yield to loop
    assert "immediate" in executed
    assert "delayed" not in executed

    # Wait for delayed
    await asyncio.sleep(0.5)
    assert executed == ["immediate", "delayed"]
