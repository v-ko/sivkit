"""SQLite engine setup shared by sivkit's SQLAlchemy-backed stores."""

from __future__ import annotations

from pathlib import Path

from sqlalchemy import URL, Engine, create_engine, event


def create_sqlite_engine(db_path: Path) -> Engine:
    """Create an engine for a SQLite file, with WAL enabled on every connection."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    engine = create_engine(URL.create("sqlite", database=str(db_path)))
    event.listen(
        engine,
        "connect",
        lambda dbapi_conn, _record: dbapi_conn.execute("PRAGMA journal_mode=wal"),
    )
    return engine
