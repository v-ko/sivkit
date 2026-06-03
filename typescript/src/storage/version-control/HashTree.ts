import { ChangeType } from "../../model/Change";
import { Store } from "../domain-store/BaseStore";
import { dumpToDict } from '../../model/Entity';
import { cryptoModule } from "../../util/base";
import { getLogger } from "../../logging";
import { Delta } from "../../model/Delta";
import { canonicalJson } from "../../util/canonicalJson";

const log = getLogger('HashTree')

const subtleCrypto = cryptoModule();

export class HangingSubtreesError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "HangingSubtreesError";
    }
}

function getEntityDataString(entity: any): string {
    const data = dumpToDict(entity);
    return canonicalJson(data);
}

// Tree structure:
// - Super-root (entityId='', virtual) anchors all root nodes
// - Root nodes (parentId='') represent top-level entities (pages)
// - Non-root nodes represent children (notes, arrows)

export class HashTreeNode {
    tree: HashTree;
    entityId: string; // The super-root has an empty id
    parentId: string = ''; // Root nodes have an empty parent id

    children: { [key: string]: HashTreeNode } = {}; // by entity id
    childrenSorted: HashTreeNode[] = []; // sorted by entity id

    entityDataHash: string = ''; // '' is possible at init or for the super root node (all others are serializable and should be specified on instantiation or at data updates)
    _hash: string = '';

    _hashOutdated: boolean = true;
    _removed: boolean = false;
    _childrenNotSorted: boolean = false;

    private constructor(tree: HashTree, entityId: string, parentId: string, entityDataHash: string) {
        this.tree = tree;
        this.entityId = entityId;
        this.parentId = parentId;
        this.entityDataHash = entityDataHash;
    }

    static createSuperRoot(tree: HashTree): HashTreeNode {
        return new HashTreeNode(tree, '', '', '');
    }

    static createRoot(tree: HashTree, entityId: string, entityDataHash: string): HashTreeNode {
        if (entityId === '') {
            throw Error("Root nodes must have an entity id");
        }
        return new HashTreeNode(tree, entityId, '', entityDataHash);
    }

    static create(tree: HashTree, entityId: string, parentId: string, entityDataHash: string): HashTreeNode {
        if (entityId === '') {
            throw Error("Entity id must not be empty");
        }
        if (parentId === '') {
            throw Error("Non-root nodes must have a parent id (use createRoot for roots)");
        }
        return new HashTreeNode(tree, entityId, parentId, entityDataHash);
    }

    data(): any {
        return {
            entityId: this.entityId,
            parentId: this.parentId,
            entityDataHash: this.entityDataHash,
            hash: this._hash,
            hashOutdated: this._hashOutdated,
            removed: this.removed,
            childrenSortOutdated: this.childrenSortOutdated,
            children: this.childrenSorted.map(child => child.data())
        }
    }

    get hash(): string {
        if (this._hashOutdated) {
            throw Error("Hash requested, but it's outdated.");
        }
        return this._hash;
    }

    get hashOutdated(): boolean {
        return this._hashOutdated;
    }
    setHashOutdated() {
        /**
         * Set hash outdated for this node and all its parents
         */
        this._hashOutdated = true;

        // Set for all parents
        let parent = this.tree.nodes[this.parentId];
        if (parent && !parent.hashOutdated) {
            parent.setHashOutdated();
        }
    }
    get removed(): boolean {
        return this._removed;
    }
    markAsRemoved() {
        this._removed = true;
        this.setHashOutdated();
    }
    get childrenSortOutdated(): boolean {
        return this._childrenNotSorted;
    }
    setChildrenSortOutdated() {
        this._childrenNotSorted = true;
        this.setHashOutdated();
    }
    sortChildren() {
        this.childrenSorted.sort((a, b) => {
            if (a.entityId < b.entityId) {
                return -1;
            }
            if (a.entityId > b.entityId) {
                return 1;
            }
            return 0;
        });
        this._childrenNotSorted = false;
        this.setHashOutdated();
    }

    addChild(child: HashTreeNode) {
        if (child.entityId === ''){
            throw Error("Cannot add a child with empty entity id. This is reserved for the super-root");
        }

        this.children[child.entityId] = child;
        this.childrenSorted.push(child);
        this.setChildrenSortOutdated();
        // this.sortChildren();
    }
    removeChild(child: HashTreeNode) {
        delete this.children[child.entityId];
        let index = this.childrenSorted.indexOf(child);
        if (index === -1) {
            throw Error(`Cannot remove child (entityId: ${child.entityId}) from node (entityId: ${this.entityId}): child not found`);
        }
        this.childrenSorted.splice(index, 1);
        this.setChildrenSortOutdated(); // not needed if sort is on every insert
    }
    safeForSubtreeRemoval(): boolean {
        if (this.removed && this.childrenSorted.length === 0) {
            return true;
        }
        for (let child of this.childrenSorted) {
            if (!child.removed || !child.safeForSubtreeRemoval()) {
                return false;
            }
        }
        return true;
    }
    async updateHash() {
        if (this.removed) {
            throw Error("Cannot update hash of a removed node");
        }

        if (this.childrenSortOutdated) {
            throw Error("Cannot update hash: children not sorted");
        }

        // Check for any removed children - they should have been cleaned up
        // And update hashes for all children
        for (let child of this.childrenSorted) {
            if (child.removed) {
                throw Error("Cannot update hash: child node marked for removal must be cleaned up first");
            }
            if (child.hashOutdated) {
                await child.updateHash();
            }
        }

        const childHashes = this.childrenSorted.map((child) => child.hash);
        this._hash = await hash(this.entityDataHash, childHashes);
        this._hashOutdated = false;
    }
}

export class HashTree {
    private _tmpSubtrees: { [key: string]: HashTreeNode[] } = {}; // by parent id
    superRoot: HashTreeNode | null = null;
    nodes: { [key: string]: HashTreeNode } = {} // by entity id
    _removedNodeCleanupNeeded: boolean = false; // Handle nodes marked for removal

    constructor() {
        this.createSuperRoot();
    }

    data(): any { // For debugging mostly
        return {
            superRoot: this.superRoot ? this.superRoot.data() : null,
            nodes: Object.values(this.nodes).map(node => node.data()),
            tmpSubtrees: Object.entries(this._tmpSubtrees).map(([parentId, nodes]) => ({
                parentId,
                nodes: nodes.map(node => node.data())
            })),
            removedNodeCleanupNeeded: this._removedNodeCleanupNeeded
        }
    }

    get removedNodeCleanupNeeded(): boolean {
        return this._removedNodeCleanupNeeded;
    }
    cleanUpRemovedNodesLater() {
        this._removedNodeCleanupNeeded = true;
    }

    private createSuperRoot() {
        if (!!this.superRoot) {
            throw Error("Cannot have multiple super-root nodes");
        }
        let superRoot = HashTreeNode.createSuperRoot(this);
        this.superRoot = superRoot;
        this.nodes[''] = superRoot;
    }

    createNode(entityId: string, parentId: string, entityDataHash: string): HashTreeNode {
        let node;
        if (parentId === '') {
            node = HashTreeNode.createRoot(this, entityId, entityDataHash);
        } else {
            node = HashTreeNode.create(this, entityId, parentId, entityDataHash);
        }
        this.insertNode(node);
        return node;
    }

    insertNode(node: HashTreeNode) {
        if (this.nodes[node.entityId]) {
            throw Error("Node with this entity id already exists");
        }

        let parent = this.nodes[node.parentId];

        if (!parent) {
            // Parent not in the tree yet — buffer for later reattachment
            // log.info('Parent not found, adding to tmp subtrees', node.parentId)
            if (!this._tmpSubtrees[node.parentId]) {
                this._tmpSubtrees[node.parentId] = [];
            }
            this._tmpSubtrees[node.parentId].push(node);
            return;
        }

        parent.addChild(node);
        this.nodes[node.entityId] = node;

        // If some of the tmp subtree roots have this node as a parent
        // reattach them properly
        if (this._tmpSubtrees[node.entityId]) {
            // log.info('Reattaching tmp subtrees', node.entityId)
            let subtree = this._tmpSubtrees[node.entityId];
            delete this._tmpSubtrees[node.entityId];

            for (let child of subtree) {
                this.insertNode(child); // This will recursively re-check
            }

        }
    }
    removeNode(node: HashTreeNode) {
        node.markAsRemoved();
        this.cleanUpRemovedNodesLater();
    }
    parent(node: HashTreeNode): HashTreeNode | null {
        return this.nodes[node.parentId] || null;
    }

    deleteNodesMarkedForRemoval() {
        /** Remove nodes marked for removal */
        // log.info('Cleaning up hash tree')
        // Remove nodes marked for removal. First detach from parents, then delete
        let forDeletion: HashTreeNode[] = [];
        for (let node of Object.values(this.nodes)) {
            if (!node.removed){
                continue;
            }

            if(node.safeForSubtreeRemoval()) {
                forDeletion.push(node); // Mark for deletion from the index
                let parent = this.parent(node)
                if (!parent) {
                    throw Error("Unexpected missing parent");
                }
                parent.removeChild(node); // Remove from parent
            } else {
                throw Error("Cannot remove node with children");
            }
        }

        // After all have been removed from the parents - actually delete them
        for (let node of forDeletion) {
            delete this.nodes[node.entityId];
        }

        this._removedNodeCleanupNeeded = false;
    }

    async updateRootHash() {
        if (!this.superRoot) {
            throw Error("Cannot update hash of an empty tree");
        }

        if (this.removedNodeCleanupNeeded) {
            this.deleteNodesMarkedForRemoval();
        }

        // Check for hanging subtrees
        if (Object.keys(this._tmpSubtrees).length > 0) {
            throw new HangingSubtreesError("Cannot update hash: hanging tmp subtrees: " + JSON.stringify(this.data()));
        }

        // Sort children where needed
        for (let node of Object.values(this.nodes)) {
            if (node.childrenSortOutdated) {
                node.sortChildren();
            }
        }

        await this.superRoot.updateHash();
    }

    rootHash(): string {
        if (!this.superRoot) {
            throw Error("Cannot get hash of an empty tree");
        }
        if (this.removedNodeCleanupNeeded) {
            throw Error("Tree needs cleanup");
        }
        if (this.superRoot.hashOutdated) {
            throw Error("Super-root hash is outdated");
        }
        return this.superRoot.hash;
    }
}


async function hash(data: string, dataForConcat: string[] = []): Promise<string> {
    // Concatenate (child hashes should be sorted by entityId)
    let concatenatedData = data + dataForConcat.join('');

    const encoder = new TextEncoder();
    const dataEncoded = encoder.encode(concatenatedData);
    const hashBuffer: ArrayBuffer = await subtleCrypto.digest("SHA-256", dataEncoded);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(byte => byte.toString(16).padStart(2, '0')).join('');

    return hashHex;
}

export async function buildHashTree(store: Store): Promise<HashTree> {
    let t0 = performance.now();
    let tree: HashTree = new HashTree();

    // Collect all entities, partition into roots and children
    let allEntities = Array.from(store.find({}));
    let rootEntities = allEntities.filter(e => e.parentId === '');
    let childEntities = allEntities.filter(e => e.parentId !== '');

    // Batch-compute all entity data hashes in parallel
    const dataStrings = allEntities.map(e => getEntityDataString(e));
    const entityHashes = await Promise.all(dataStrings.map(d => hash(d)));

    let hashByEntityId: { [id: string]: string } = {};
    for (let i = 0; i < allEntities.length; i++) {
        hashByEntityId[allEntities[i].id] = entityHashes[i];
    }

    // Insert roots first so children find their parent in the tree
    for (let root of rootEntities) {
        tree.createNode(root.id, '', hashByEntityId[root.id]);
    }
    // Insert children in topological order (parents before their children)
    let remaining = [...childEntities];
    let prevLength = remaining.length + 1;
    while (remaining.length > 0 && remaining.length < prevLength) {
        prevLength = remaining.length;
        let deferred: typeof remaining = [];
        for (let entity of remaining) {
            if (tree.nodes[entity.parentId]) {
                tree.createNode(entity.id, entity.parentId, hashByEntityId[entity.id]);
            } else {
                deferred.push(entity);
            }
        }
        remaining = deferred;
    }
    if (remaining.length > 0) {
        log.warning(`${remaining.length} entities have missing parents and were not added to hash tree`);
    }

    await tree.updateRootHash();
    let t1 = performance.now();
    log.info(`Hash tree built in ${t1 - t0} ms`);
    return tree
}

export async function updateHashTree(tree: HashTree, store: Store, delta: Delta) {
    let t0 = performance.now();
    // For deletions - remove the node
    for (let change of delta.changes()) {
        let changeType = change.type();
        let entity = store.findOne({ id: change.entityId });

        if (changeType === ChangeType.DELETE) {
            let node = tree.nodes[change.entityId];
            if (!node) {
                throw Error("Cannot delete a node that doesn't exist");
            }
            tree.removeNode(node);

        } else if (changeType === ChangeType.UPDATE) {
            let node = tree.nodes[change.entityId];
            if (!node){
                throw Error("Cannot update a node that doesn't exist");
            }
            if (entity === undefined) {
                throw Error(`Entity not found for the given change ${change.entityId}`);
            }
            const data = getEntityDataString(entity);
            node.entityDataHash = await hash(data);

            // Handle reparenting: if parent_id changed, move the node
            if (node.parentId !== entity.parentId) {
                let oldParent = tree.nodes[node.parentId];
                if (oldParent) {
                    oldParent.removeChild(node);
                }
                let newParent = tree.nodes[entity.parentId];
                if (!newParent) {
                    throw Error(
                        `New parent '${entity.parentId}' not found for ` +
                        `reparented entity ${change.entityId}`
                    );
                }
                node.parentId = entity.parentId;
                newParent.addChild(node);
            }
            node.setHashOutdated();

        } else if (changeType === ChangeType.CREATE) {
            if (entity === undefined) {
                throw Error(`Entity not found for the given change ${change.entityId}`);
            }
            const data = getEntityDataString(entity);
            let hashString = await hash(data);
            tree.createNode(change.entityId, entity.parentId, hashString);
        } else {
            throw Error("Unexpected change type");
        }
    }
    await tree.updateRootHash();
    let t1 = performance.now();
    // log.info(`Hash tree updated in ${t1 - t0} ms`);
}
