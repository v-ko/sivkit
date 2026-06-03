from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from sivkit.storage.delta import Delta, DeltaData


@dataclass
class CommitMetadata:
    id: str
    parent_id: str
    snapshot_hash: str
    timestamp: float  # milliseconds since epoch (matches TS Date.now())
    message: str

    def asdict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "parent_id": self.parent_id,
            "snapshot_hash": self.snapshot_hash,
            "timestamp": self.timestamp,
            "message": self.message,
        }

    @staticmethod
    def from_dict(data: dict[str, Any]) -> CommitMetadata:
        return CommitMetadata(
            id=data["id"],
            parent_id=data["parent_id"],
            snapshot_hash=data["snapshot_hash"],
            timestamp=data["timestamp"],
            message=data["message"],
        )


@dataclass
class Commit:
    id: str
    parent_id: str
    snapshot_hash: str
    timestamp: float  # milliseconds since epoch
    message: str
    delta_data: DeltaData = field(default_factory=dict)

    def asdict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "parent_id": self.parent_id,
            "snapshot_hash": self.snapshot_hash,
            "timestamp": self.timestamp,
            "message": self.message,
            "delta_data": self.delta_data,
        }

    @staticmethod
    def from_dict(data: dict[str, Any]) -> Commit:
        return Commit(
            id=data["id"],
            parent_id=data["parent_id"],
            snapshot_hash=data["snapshot_hash"],
            timestamp=data["timestamp"],
            message=data["message"],
            delta_data=data.get("delta_data", {}),
        )

    @property
    def delta(self) -> Delta:
        return Delta.from_data(self.delta_data)

    def metadata(self) -> CommitMetadata:
        return CommitMetadata(
            id=self.id,
            parent_id=self.parent_id,
            snapshot_hash=self.snapshot_hash,
            timestamp=self.timestamp,
            message=self.message,
        )
