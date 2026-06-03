from __future__ import annotations

import hashlib
from typing import Any

from sivkit import get_logger
from sivkit.libs.canonical_json import canonical_json
from sivkit.libs.model import Entity, dump_to_dict
from sivkit.storage.base_store import Store
from sivkit.storage.change import ChangeTypes
from sivkit.storage.delta import Delta

log = get_logger(__name__)


class HangingSubtreesError(Exception):
    pass


def _get_entity_data_string(entity: Entity) -> str:
    data = dump_to_dict(entity)
    return canonical_json(data)


def _hash(data: str, data_for_concat: list[str] | None = None) -> str:
    """SHA-256 hash of data + concatenated child hashes."""
    concatenated = data + "".join(data_for_concat or [])
    return hashlib.sha256(concatenated.encode()).hexdigest()


# Tree structure:
# - Super-root (entity_id='', virtual) anchors all root nodes
# - Root nodes (parent_id='') represent top-level entities (pages)
# - Non-root nodes represent children (notes, arrows)


class HashTreeNode:
    __slots__ = (
        "tree",
        "entity_id",
        "parent_id",
        "children",
        "children_sorted",
        "entity_data_hash",
        "_hash",
        "_hash_outdated",
        "_removed",
        "_children_not_sorted",
    )

    def __init__(
        self,
        tree: HashTree,
        entity_id: str,
        parent_id: str,
        entity_data_hash: str,
    ) -> None:
        self.tree = tree
        self.entity_id = entity_id
        self.parent_id = parent_id
        self.entity_data_hash = entity_data_hash
        self.children: dict[str, HashTreeNode] = {}
        self.children_sorted: list[HashTreeNode] = []
        self._hash: str = ""
        self._hash_outdated: bool = True
        self._removed: bool = False
        self._children_not_sorted: bool = False

    @staticmethod
    def create_super_root(tree: HashTree) -> HashTreeNode:
        return HashTreeNode(tree, "", "", "")

    @staticmethod
    def create_root(
        tree: HashTree, entity_id: str, entity_data_hash: str
    ) -> HashTreeNode:
        if not entity_id:
            raise ValueError("Root nodes must have an entity id")
        return HashTreeNode(tree, entity_id, "", entity_data_hash)

    @staticmethod
    def create(
        tree: HashTree,
        entity_id: str,
        parent_id: str,
        entity_data_hash: str,
    ) -> HashTreeNode:
        if not entity_id:
            raise ValueError("Entity id must not be empty")
        if not parent_id:
            raise ValueError(
                "Non-root nodes must have a parent id (use create_root for roots)"
            )
        return HashTreeNode(tree, entity_id, parent_id, entity_data_hash)

    @property
    def hash(self) -> str:
        if self._hash_outdated:
            raise RuntimeError("Hash requested, but it's outdated.")
        return self._hash

    @property
    def hash_outdated(self) -> bool:
        return self._hash_outdated

    def set_hash_outdated(self) -> None:
        self._hash_outdated = True
        parent = self.tree.nodes.get(self.parent_id)
        if parent and not parent.hash_outdated:
            parent.set_hash_outdated()

    @property
    def removed(self) -> bool:
        return self._removed

    def mark_as_removed(self) -> None:
        self._removed = True
        self.set_hash_outdated()

    @property
    def children_sort_outdated(self) -> bool:
        return self._children_not_sorted

    def set_children_sort_outdated(self) -> None:
        self._children_not_sorted = True
        self.set_hash_outdated()

    def sort_children(self) -> None:
        self.children_sorted.sort(key=lambda n: n.entity_id)
        self._children_not_sorted = False
        self.set_hash_outdated()

    def add_child(self, child: HashTreeNode) -> None:
        if not child.entity_id:
            raise ValueError("Cannot add a child with empty entity id")
        self.children[child.entity_id] = child
        self.children_sorted.append(child)
        self.set_children_sort_outdated()

    def remove_child(self, child: HashTreeNode) -> None:
        del self.children[child.entity_id]
        try:
            self.children_sorted.remove(child)
        except ValueError:
            raise ValueError(
                f"Cannot remove child (entity_id: {child.entity_id}) "
                f"from node (entity_id: {self.entity_id}): child not found"
            )
        self.set_children_sort_outdated()

    def safe_for_subtree_removal(self) -> bool:
        if self.removed and not self.children_sorted:
            return True
        return all(
            child.removed and child.safe_for_subtree_removal()
            for child in self.children_sorted
        )

    def update_hash(self) -> None:
        if self.removed:
            raise RuntimeError("Cannot update hash of a removed node")
        if self.children_sort_outdated:
            raise RuntimeError("Cannot update hash: children not sorted")

        for child in self.children_sorted:
            if child.removed:
                raise RuntimeError(
                    "Cannot update hash: child node marked for removal must be cleaned up first"
                )
            if child.hash_outdated:
                child.update_hash()

        child_hashes = [child.hash for child in self.children_sorted]
        self._hash = _hash(self.entity_data_hash, child_hashes)
        self._hash_outdated = False


class HashTree:
    def __init__(self) -> None:
        self._tmp_subtrees: dict[str, list[HashTreeNode]] = {}
        self.super_root: HashTreeNode | None = None
        self.nodes: dict[str, HashTreeNode] = {}
        self._removed_node_cleanup_needed: bool = False
        self._create_super_root()

    @property
    def removed_node_cleanup_needed(self) -> bool:
        return self._removed_node_cleanup_needed

    def clean_up_removed_nodes_later(self) -> None:
        self._removed_node_cleanup_needed = True

    def _create_super_root(self) -> None:
        if self.super_root is not None:
            raise RuntimeError("Cannot have multiple super-root nodes")
        super_root = HashTreeNode.create_super_root(self)
        self.super_root = super_root
        self.nodes[""] = super_root

    def create_node(
        self, entity_id: str, parent_id: str, entity_data_hash: str
    ) -> HashTreeNode:
        if parent_id == "":
            node = HashTreeNode.create_root(self, entity_id, entity_data_hash)
        else:
            node = HashTreeNode.create(self, entity_id, parent_id, entity_data_hash)
        self.insert_node(node)
        return node

    def insert_node(self, node: HashTreeNode) -> None:
        if node.entity_id in self.nodes:
            raise ValueError(f"Node with entity id {node.entity_id!r} already exists")

        parent = self.nodes.get(node.parent_id)

        if parent is None:
            # Parent not in the tree yet — buffer for later reattachment
            # log.info("Parent not found, adding to tmp subtrees: %s", node.parent_id)
            self._tmp_subtrees.setdefault(node.parent_id, []).append(node)
            return

        parent.add_child(node)
        self.nodes[node.entity_id] = node

        # Reattach any pending children
        if node.entity_id in self._tmp_subtrees:
            # log.info("Reattaching tmp subtrees for %s", node.entity_id)
            subtree = self._tmp_subtrees.pop(node.entity_id)
            for child in subtree:
                self.insert_node(child)

    def remove_node(self, node: HashTreeNode) -> None:
        node.mark_as_removed()
        self.clean_up_removed_nodes_later()

    def parent(self, node: HashTreeNode) -> HashTreeNode | None:
        return self.nodes.get(node.parent_id)

    def delete_nodes_marked_for_removal(self) -> None:
        for_deletion: list[HashTreeNode] = []
        for node in self.nodes.values():
            if not node.removed:
                continue
            if node.safe_for_subtree_removal():
                for_deletion.append(node)
                parent = self.parent(node)
                if parent is None:
                    raise RuntimeError("Unexpected missing parent")
                parent.remove_child(node)
            else:
                raise RuntimeError("Cannot remove node with children")

        for node in for_deletion:
            del self.nodes[node.entity_id]

        self._removed_node_cleanup_needed = False

    def update_root_hash(self) -> None:
        if self.super_root is None:
            raise RuntimeError("Cannot update hash of an empty tree")

        if self.removed_node_cleanup_needed:
            self.delete_nodes_marked_for_removal()

        if self._tmp_subtrees:
            raise HangingSubtreesError(
                f"Cannot update hash: hanging tmp subtrees for parent ids: "
                f"{list(self._tmp_subtrees.keys())}"
            )

        # Sort children where needed
        for node in self.nodes.values():
            if node.children_sort_outdated:
                node.sort_children()

        self.super_root.update_hash()

    def root_hash(self) -> str:
        if self.super_root is None:
            raise RuntimeError("Cannot get hash of an empty tree")
        if self.removed_node_cleanup_needed:
            raise RuntimeError("Tree needs cleanup")
        if self.super_root.hash_outdated:
            raise RuntimeError("Super-root hash is outdated")
        return self.super_root.hash


def build_hash_tree(store: Store) -> HashTree:
    """Build a HashTree from the current state of a Store."""
    tree = HashTree()

    # Partition all entities into roots (parent_id="") and children.
    # We iterate all entities because the Python InMemoryStore doesn't index
    # entities with empty parent_id (empty string is falsy).
    all_entities: list[Entity] = list(store.find())
    root_entities = [e for e in all_entities if e.parent_id == ""]
    child_entities = [e for e in all_entities if e.parent_id != ""]

    # Compute all entity data hashes
    hash_by_entity_id: dict[str, str] = {}
    for entity in all_entities:
        data_string = _get_entity_data_string(entity)
        hash_by_entity_id[entity.id] = _hash(data_string)

    # Insert roots first so children find their parents
    for root in root_entities:
        tree.create_node(root.id, "", hash_by_entity_id[root.id])
    for entity in child_entities:
        tree.create_node(entity.id, entity.parent_id, hash_by_entity_id[entity.id])

    tree.update_root_hash()
    return tree


def update_hash_tree(tree: HashTree, store: Store, delta: Delta) -> None:
    """Incrementally update a HashTree after a Delta has been applied to the Store."""
    for change in delta.changes():
        change_type = change.type()
        entity = store.find_one(id=change.entity_id)

        if change_type == ChangeTypes.DELETE:
            node = tree.nodes.get(change.entity_id)
            if node is None:
                raise ValueError(
                    f"Cannot delete a node that doesn't exist: {change.entity_id}"
                )
            tree.remove_node(node)

        elif change_type == ChangeTypes.UPDATE:
            node = tree.nodes.get(change.entity_id)
            if node is None:
                raise ValueError(
                    f"Cannot update a node that doesn't exist: {change.entity_id}"
                )
            if entity is None:
                raise ValueError(f"Entity not found for change {change.entity_id}")
            data_string = _get_entity_data_string(entity)
            node.entity_data_hash = _hash(data_string)

            # Handle reparenting: if parent_id changed, move the node
            if node.parent_id != entity.parent_id:
                old_parent = tree.nodes.get(node.parent_id)
                if old_parent is not None:
                    old_parent.remove_child(node)
                new_parent = tree.nodes.get(entity.parent_id)
                if new_parent is None:
                    raise ValueError(
                        f"New parent {entity.parent_id!r} not found for "
                        f"reparented entity {change.entity_id}"
                    )
                node.parent_id = entity.parent_id
                new_parent.add_child(node)

            node.set_hash_outdated()

        elif change_type == ChangeTypes.CREATE:
            if entity is None:
                raise ValueError(f"Entity not found for change {change.entity_id}")
            data_string = _get_entity_data_string(entity)
            hash_string = _hash(data_string)
            tree.create_node(change.entity_id, entity.parent_id, hash_string)

        elif change_type == ChangeTypes.EMPTY:
            continue  # No-op change, skip

        else:
            raise ValueError(f"Unexpected change type: {change_type}")

    tree.update_root_hash()
