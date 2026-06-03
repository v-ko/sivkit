"""Tests for the @procedure decorator and Qt-async event loop integration."""

import asyncio

import pytest

from sivkit.libs.procedure import procedure


@pytest.mark.asyncio
async def test_procedure_schedules_and_returns_task():
    """Calling a @procedure function returns a running Task."""

    @procedure
    async def add(x, y):
        return x + y

    task = add(2, 3)
    assert isinstance(task, asyncio.Task)
    result = await task
    assert result == 5


@pytest.mark.asyncio
async def test_procedure_with_await():
    """Procedure can await other coroutines."""

    @procedure
    async def delayed_double(n):
        await asyncio.sleep(0)
        return n * 2

    result = await delayed_double(7)
    assert result == 14


@pytest.mark.asyncio
async def test_procedure_fire_and_forget():
    """Procedure can be called without awaiting (fire-and-forget)."""
    results = []

    @procedure
    async def append_value(val):
        results.append(val)

    append_value(42)
    # Let the task run
    await asyncio.sleep(0)
    assert results == [42]


@pytest.mark.asyncio
async def test_procedure_exception_is_logged(caplog):
    """Unhandled exceptions in procedures are logged, not silently lost."""

    @procedure
    async def failing():
        raise ValueError("test error")

    task = failing()
    # Wait for the task to complete
    with pytest.raises(ValueError, match="test error"):
        await task


@pytest.mark.asyncio
async def test_procedure_preserves_name():
    """Task name is set to the function's qualified name."""

    @procedure
    async def my_func():
        pass

    task = my_func()
    assert "my_func" in task.get_name()
    await task


def test_procedure_rejects_non_async():
    """@procedure raises TypeError on non-async functions."""
    with pytest.raises(TypeError, match="async functions"):

        @procedure
        def not_async():
            pass


@pytest.mark.asyncio
async def test_procedure_awaits_another_procedure():
    """A procedure can await another procedure."""

    @procedure
    async def inner(x):
        return x + 1

    @procedure
    async def outer(x):
        val = await inner(x)
        return val * 2

    result = await outer(5)
    assert result == 12
