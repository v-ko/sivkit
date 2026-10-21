"""Cost of SivKit's file writes against plain writes. Run by hand, not in the suite:

    python benchmarks/fs_writes.py <empty folder on the disk to measure>

Use a real disk, not tmpfs (often `/tmp`), where fsync costs nothing.
"""

import argparse
import asyncio
import os
import shutil
import statistics
import time
from pathlib import Path

from sivkit.storage.fs.changes import Create, Replace, apply
from sivkit.storage.fs.ops import atomic_replace, create_new, make_folder, move

WORKLOADS = {"1000 x 4 KB": (1000, 4 * 1024), "10 x 50 MB": (10, 50 * 1024**2)}


def write_bytes(path, data):
    path.write_bytes(data)


def write_fsync(path, data):
    with open(path, "wb") as file:
        file.write(data)
        file.flush()
        os.fsync(file.fileno())


def run_sequential(write, paths, data):
    times = []
    for path in paths:
        start = time.perf_counter()
        write(path, data)
        times.append(time.perf_counter() - start)
    return times


async def run_apply(folder, change_type, names, data, concurrent):
    async def one(name):
        start = time.perf_counter()
        done = await apply(folder.parent, change_type(f"{folder.name}/{name}", data))
        assert done.error is None, done.error
        return time.perf_counter() - start

    if concurrent:
        return list(await asyncio.gather(*[one(name) for name in names]))
    return [await one(name) for name in names]


def cases(mode):
    """(name, function of (folder, names, data) returning per-file times)."""

    def sequential(write):
        return lambda folder, names, data: run_sequential(
            write, [folder / n for n in names], data
        )

    def applied(concurrent):
        change_type = Create if mode == "create" else Replace
        return lambda folder, names, data: asyncio.run(
            run_apply(folder, change_type, names, data, concurrent)
        )

    yield "write_bytes", sequential(write_bytes)
    yield "write_bytes + fsync", sequential(write_fsync)
    for durable in (False, True):
        yield f"atomic_replace durable={durable}", sequential(
            lambda p, d, durable=durable: atomic_replace(p, d, durable=durable)
        )
        if mode == "create":
            yield f"create_new durable={durable}", sequential(
                lambda p, d, durable=durable: create_new(p, d, durable=durable)
            )
    yield "apply, one at a time", applied(False)
    yield "apply, gather", applied(True)
    if mode == "replace":
        yield "move", lambda folder, names, data: run_sequential(
            lambda p, d: move(p, p.with_name("moved-" + p.name)),
            [folder / n for n in names],
            data,
        )


def measure(base, count, size, mode, run):
    folder = base / "case"
    make_folder(folder)
    names = [f"file{i}.bin" for i in range(count)]
    data = os.urandom(size)
    if mode == "replace":
        for name in names:
            (folder / name).write_bytes(data)
    os.sync()  # Don't charge earlier writes to this case
    start = time.perf_counter()
    times = run(folder, names, data)
    total = time.perf_counter() - start
    os.sync()
    shutil.rmtree(folder)
    return total, times


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("folder", type=Path)
    base = parser.parse_args().folder
    if any(base.iterdir()):
        parser.error(f"{base} isn't empty")

    header = f"{'case':34} {'total s':>8} {'files/s':>8} {'MB/s':>7} {'median ms':>9} {'p95 ms':>8} {'x write':>7} {'x fsync':>7}"
    for workload, (count, size) in WORKLOADS.items():
        for mode in ("replace", "create"):
            print(f"\n{workload}, {mode}\n{header}")
            results = {
                name: measure(base, count, size, mode, run) for name, run in cases(mode)
            }
            plain = results["write_bytes"][0]
            synced = results["write_bytes + fsync"][0]
            for name, (total, times) in results.items():
                p95 = statistics.quantiles(times, n=20, method="inclusive")[-1]
                print(
                    f"{name:34} {total:8.3f} {count / total:8.0f}"
                    f" {count * size / total / 1e6:7.0f}"
                    f" {statistics.median(times) * 1e3:9.2f} {p95 * 1e3:8.2f}"
                    f" {total / plain:7.2f} {total / synced:7.2f}"
                )


if __name__ == "__main__":
    main()
