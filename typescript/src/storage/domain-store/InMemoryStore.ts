import { IrrationalStorageOperation, Store, SearchFilter } from "./BaseStore"
import { Entity, EntityData, getEntityClassByName } from "../../model/Entity"
import { Change } from "../../model/Change"
import { Delta } from "../../model/Delta"
import { getLogger } from "../../logging"

const log = getLogger('InMemoryRepository')

export const ENTITY_TYPE_INDEX_KEY = 'entityType';
// Core type definitions
export interface IndexField {
    indexKey: string;
    allowedTypes?: string[]; // Constructor functions for base classes
}

interface ResolvedIndexField extends IndexField {
    resolvedAllowedTypes?: (typeof Entity)[]; // Resolved types for instanceof checks
}

// Index configuration with metadata
export interface IndexConfig {
    readonly fields: IndexField[];
    readonly isUnique: boolean; // If the added entities are expected to be unique
    readonly name?: string;
}

// Internal representation of a fully processed and validated index configuration
interface ResolvedIndexConfig extends IndexConfig {
    name: string;
    isUnique: boolean;
    resolvedFields: ResolvedIndexField[]; // To make the instanceof checks with
}

// Index value types
type IndexValue = Entity<EntityData> | Entity<EntityData>[];

// Index key generation
type IndexKey = string;

// Helper function to check if a field is an EntityTypeIndexConfig
function isEntityTypeIndexConfig(field: IndexField): boolean {
    return field.indexKey === ENTITY_TYPE_INDEX_KEY;
}

// Generate index schema from definition
function getIndexSchema(fields: IndexField[]): string {
    const nameParts: string[] = [];

    for (const field of fields) {
        // Stage 1: Check if this is an entity type index configuration
        if (isEntityTypeIndexConfig(field)) {
            // Stage 2: Convert entity type config to standard type name
            nameParts.push('__type__');
        } else {
            // Stage 3: Handle regular string field names
            nameParts.push(field.indexKey);
        }
    }

    // Stage 4: Join all parts with separator
    return nameParts.join('|');
}

// Generate index key from entity and definition
function generateIndexKey(entity: Entity<EntityData>, config: ResolvedIndexConfig): IndexKey | null {
    const keyParts: string[] = [];

    for (const field of config.resolvedFields) {
        let value: any;

        if (isEntityTypeIndexConfig(field)) {
            // For entity type config, check if entity matches any allowed types
            let matchedType: string | null = null;

            // Check if entity is instance of any allowed base types
            for (const allowedType of field.resolvedAllowedTypes!) {
                if (entity instanceof allowedType) {
                    matchedType = allowedType.name;
                    break;
                }
            }

            // If no match found, this entity shouldn't be indexed by this config
            if (matchedType === null) {
                return null;
            }

            value = matchedType;
        } else {
            // Access entity property directly (not from _data)
            value = (entity as any)[field.indexKey];
        }

        // Exclude entities with undefined index properties
        if (value === undefined) {
            return null;
        }

        // Convert to string for key generation
        keyParts.push(String(value));
    }

    return keyParts.join('|');
}

// Index management system
class IndexManager {
    private indexes = new Map<string, Map<IndexKey, IndexValue>>();
    private resolvedIndexConfigs = new Map<string, ResolvedIndexConfig>();

    constructor(indexConfigs: readonly IndexConfig[]) {
        if (indexConfigs.length === 0) {
            throw new Error("At least one index definition is required. Entities are stored only in indexes.");
        }
        this.initializeIndexes(indexConfigs);
    }

    private initializeIndexes(configs: readonly IndexConfig[]): void {
        for (const config of configs) {
            const indexName = config.name || getIndexSchema(config.fields);
            if (this.resolvedIndexConfigs.has(indexName)) {
                throw new Error(`Duplicate index name: "${indexName}"`);
            }

            const resolvedFields: ResolvedIndexField[] = config.fields.map(field => {
                if (isEntityTypeIndexConfig(field)) {
                    if (!field.allowedTypes || field.allowedTypes.length === 0) {
                        throw new Error(`Index of type '${ENTITY_TYPE_INDEX_KEY}' must have a non-empty 'allowedTypes' array. Index name: "${indexName}"`);
                    }
                    const resolvedAllowedTypes = field.allowedTypes.map(typeName => {
                        const cls = getEntityClassByName(typeName);
                        if (!cls) {
                            throw new Error(`Entity class "${typeName}" not found for index "${indexName}"`);
                        }
                        return cls;
                    });
                    return { ...field, resolvedAllowedTypes };
                } else if (field.allowedTypes) {
                    log.warning(`'allowedTypes' is only applicable for '${ENTITY_TYPE_INDEX_KEY}' indexes. Ignoring for index "${indexName}".`);
                }
                return field;
            });

            const resolvedConfig: ResolvedIndexConfig = {
                ...config,
                name: indexName,
                isUnique: config.isUnique,
                resolvedFields: resolvedFields,
            };

            this.resolvedIndexConfigs.set(indexName, resolvedConfig);
            this.indexes.set(indexName, new Map());
        }
    }

    addEntity(entity: Entity<EntityData>): void {
        for (const [indexName, config] of this.resolvedIndexConfigs) {
            const indexKey = generateIndexKey(entity, config);
            if (indexKey === null) continue; // Skip if any field is undefined

            const index = this.indexes.get(indexName)!;

            if (config.isUnique) {
                index.set(indexKey, entity);
            } else {
                const existing = index.get(indexKey) as Entity<EntityData>[] | undefined;
                if (existing) {
                    existing.push(entity);
                } else {
                    index.set(indexKey, [entity]);
                }
            }
        }
    }

    removeEntity(entity: Entity<EntityData>): void {
        for (const [indexName, config] of this.resolvedIndexConfigs) {
            const indexKey = generateIndexKey(entity, config);
            if (indexKey === null) continue;

            const index = this.indexes.get(indexName)!;

            if (config.isUnique) {
                index.delete(indexKey);
            } else {
                const entities = index.get(indexKey) as Entity<EntityData>[] | undefined;
                if (entities) {
                    const entityIndex = entities.findIndex(e => e.id === entity.id);
                    if (entityIndex !== -1) {
                        entities.splice(entityIndex, 1);
                        if (entities.length === 0) {
                            index.delete(indexKey);
                        }
                    }
                }
            }
        }
    }

    updateEntity(oldEntity: Entity<EntityData>, newEntity: Entity<EntityData>): void {
        for (const [indexName, config] of this.resolvedIndexConfigs) {
            const oldIndexKey = generateIndexKey(oldEntity, config);
            const newIndexKey = generateIndexKey(newEntity, config);

            if (oldIndexKey !== newIndexKey) {
                // Index key changed — remove from old position, add to new
                if (oldIndexKey !== null) {
                    const index = this.indexes.get(indexName)!;

                    if (config.isUnique) {
                        index.delete(oldIndexKey);
                    } else {
                        const entities = index.get(oldIndexKey) as Entity<EntityData>[] | undefined;
                        if (entities) {
                            const entityIndex = entities.findIndex(e => e.id === oldEntity.id);
                            if (entityIndex !== -1) {
                                entities.splice(entityIndex, 1);
                                if (entities.length === 0) {
                                    index.delete(oldIndexKey);
                                }
                            }
                        }
                    }
                }

                if (newIndexKey !== null) {
                    const index = this.indexes.get(indexName)!;

                    if (config.isUnique) {
                        index.set(newIndexKey, newEntity);
                    } else {
                        const existing = index.get(newIndexKey) as Entity<EntityData>[] | undefined;
                        if (existing) {
                            existing.push(newEntity);
                        } else {
                            index.set(newIndexKey, [newEntity]);
                        }
                    }
                }
            } else if (oldIndexKey !== null) {
                // Same key — just update the entity reference in place
                const index = this.indexes.get(indexName)!;

                if (config.isUnique) {
                    index.set(oldIndexKey, newEntity);
                } else {
                    const entities = index.get(oldIndexKey) as Entity<EntityData>[] | undefined;
                    if (entities) {
                        const entityIndex = entities.findIndex(e => e.id === oldEntity.id);
                        if (entityIndex !== -1) {
                            entities[entityIndex] = newEntity;
                        }
                    }
                }
            }
        }
    }

    // Getter for accessing indexes (used by QueryOptimizer)
    get indexStorage() {
        return {
            indexes: this.indexes,
            indexConfigs: this.resolvedIndexConfigs
        };
    }
}

// Query optimization
interface QueryPlan {
    indexName: string;
    indexKey: IndexKey;
    estimatedSelectivity: number;
}

class QueryOptimizer {
    constructor(private indexManager: IndexManager) {}

    findBestIndex(filter: SearchFilter): QueryPlan | null {
        const candidates: QueryPlan[] = [];
        const { indexes, indexConfigs } = this.indexManager.indexStorage;

        // Check each index to see if it can satisfy the filter
        for (const [indexName, config] of indexConfigs) {
            const indexKey = this.tryGenerateFilterKey(filter, config);
            if (indexKey !== null) {
                const selectivity = this.estimateSelectivity(indexName, indexKey, indexes);
                candidates.push({ indexName, indexKey, estimatedSelectivity: selectivity });
            }
        }

        // Sort by selectivity (lower is better - fewer results)
        candidates.sort((a, b) => a.estimatedSelectivity - b.estimatedSelectivity);

        return candidates[0] || null;
    }

    private tryGenerateFilterKey(filter: SearchFilter, config: ResolvedIndexConfig): IndexKey | null {
        const keyParts: string[] = [];

        for (const field of config.resolvedFields) {
            let value: any;

            if (isEntityTypeIndexConfig(field)) {
                // For entity type config, check if the filter type matches any allowed types
                if (!filter.type) {
                    return null; // No type in filter, can't use this index
                }

                let matchedType: string | null = null;
                // Here we check if filter.type (a class constructor) is a subclass of any of the resolved allowed types
                for (const allowedType of field.resolvedAllowedTypes!) {
                    if (filter.type === allowedType) {
                        // Entities get indexed by the allowed class the matched
                        // on insertion. Therefore here we can safely use a
                        // strict equivalence check.
                        matchedType = allowedType.name;
                        break;
                    }
                }

                if (matchedType === null) {
                    log.info('Query type not in configured index types - falling back to full scan');
                    return null; // Type not in allowed types, fall back to scan
                }

                value = matchedType;
            } else {
                value = filter[field.indexKey];
            }

            if (value === undefined) {
                return null; // Cannot use this index
            }

            keyParts.push(String(value));
        }

        return keyParts.join('|');
    }

    private estimateSelectivity(indexName: string, indexKey: IndexKey, indexes: Map<string, Map<IndexKey, IndexValue>>): number {
        const index = indexes.get(indexName)!;
        const value = index.get(indexKey);

        if (!value) return 0;

        // For unique indexes, selectivity is always 1
        if (!Array.isArray(value)) return 1;

        // For multi-value indexes, return array length
        return value.length;
    }
}

export const DEFAULT_INDEX_CONFIGS_LIST: readonly IndexConfig[] = [
    {
        name: "id",
        fields: [{ indexKey: "id" }],
        isUnique: true
    },

    {
        name: "parentId",
        fields: [{ indexKey: "parentId" }],
        isUnique: false
    },
    // { Example for how to use the type index and compound index (with type)
    //     name: ENTITY_TYPE_INDEX_KEY,
    //     fields: [{ indexKey: ENTITY_TYPE_INDEX_KEY, allowedTypes: ["Note", "Arrow"] }],
    //     isUnique: false
    // },
    // {
    //     name: "type_parentId",
    //     fields: [
    //         { indexKey: ENTITY_TYPE_INDEX_KEY, allowedTypes: ["Note", "Arrow"] },
    //         { indexKey: "parentId" }
    //     ],
    //     isUnique: false
    // }
]

export class InMemoryStore extends Store {
    private indexManager: IndexManager;
    private queryOptimizer: QueryOptimizer;

    constructor(
        indexConfigs: readonly IndexConfig[] = DEFAULT_INDEX_CONFIGS_LIST
    ) {
        super();
        this.indexManager = new IndexManager(indexConfigs);
        this.queryOptimizer = new QueryOptimizer(this.indexManager);
    }

    private upsertToCache(entity: Entity<EntityData>, isNew: boolean): Change {
        // Copy the entity to protect the repo from untracked changes
        entity = entity.copy();

        if (isNew) {
            // For new entities, just add to all indexes
            this.indexManager.addEntity(entity);
            return Change.create(entity);
        } else {
            // For updates, get the old entity and create change first
            const { indexes } = this.indexManager.indexStorage;
            const idIndex = indexes.get("id");
            const oldEntity = idIndex?.get(entity.id) as Entity<EntityData> | undefined;

            if (!oldEntity) {
                throw new IrrationalStorageOperation(`Entity with ID ${entity.id} does not exist for update.`);
            }

            // Create the change object to get what fields actually changed
            const change = Change.update(oldEntity, entity);

            // Update indexes by comparing actual index keys on old vs new entity
            this.indexManager.updateEntity(oldEntity, entity);

            return change;
        }
    }

    private removeFromCache(entity: Entity<EntityData>): void {
        this.indexManager.removeEntity(entity);
    }

    insertOne(entity: Entity<EntityData>): Change {
        if (!this._applyingInternally) this._assertInActionIfRequired();
        // console.log('Inserting entity', entity.id, entity.parentId, entity.constructor.name)

        // Check if entity already exists using the id index
        const { indexes } = this.indexManager.indexStorage;
        const idIndex = indexes.get("id");
        if (idIndex && idIndex.has(entity.id)) {
            throw new IrrationalStorageOperation(`Entity with ID ${entity.id} already exists.`);
        }

        const change = this.upsertToCache(entity, true);
        if (!this._applyingInternally) {
            this._fireOnChangesWithRollback(Delta.fromChanges([change]));
        }
        return change;
    }

    updateOne(entity: Entity<EntityData>): Change {
        if (!this._applyingInternally) this._assertInActionIfRequired();
        const change = this.upsertToCache(entity, false);
        if (!this._applyingInternally && !change.isEmpty()) {
            this._fireOnChangesWithRollback(Delta.fromChanges([change]));
        }
        return change;
    }

    removeOne(entity: Entity<EntityData>): Change {
        if (!this._applyingInternally) this._assertInActionIfRequired();
        // Check if entity exists using the id index
        const { indexes } = this.indexManager.indexStorage;
        const idIndex = indexes.get("id");
        const oldEntity = idIndex?.get(entity.id) as Entity<EntityData> | undefined;

        if (!oldEntity) {
            throw new IrrationalStorageOperation(`Entity with ID ${entity.id} does not exist.`);
        }

        this.removeFromCache(oldEntity);
        const change = Change.delete(entity);
        if (!this._applyingInternally) {
            this._fireOnChangesWithRollback(Delta.fromChanges([change]));
        }
        return change;
    }

    *find<T extends Entity<EntityData>>(filter: SearchFilter = {}): Generator<T> {
        // console.log('InMemoryStore.find called with filter:', filter);
        const { type, ...otherFilters } = filter;

        // Try to find the best index for this query
        const queryPlan = this.queryOptimizer.findBestIndex(filter);
        // console.log('Query plan:', queryPlan);

        let candidates: Entity<EntityData>[] = [];

        if (queryPlan) {
            // Use the optimized index
            const { indexes } = this.indexManager.indexStorage;
            const index = indexes.get(queryPlan.indexName)!;
            const result = index.get(queryPlan.indexKey);
            // console.log('Index result:', result);

            if (result) {
                candidates = Array.isArray(result) ? result : [result];
            }
        } else {
            // Fallback to full scan using the id index
            const { indexes } = this.indexManager.indexStorage;
            const allEntitiesIndex = indexes.get("id");
            log.info('Fallback to full scan, id index size:', allEntitiesIndex?.size);
            if (allEntitiesIndex) {
                candidates = Array.from(allEntitiesIndex.values()) as Entity<EntityData>[];
            }
        }

        // console.log('Candidates found:', candidates.length);

        // Apply additional filters
        candidatesLoop: for (const candidate of candidates) {
            // console.log('Processing candidate:', candidate.constructor.name, candidate.id);

            // Type filter (if not already handled by index)
            if (type && !(candidate instanceof type)) {
                // console.log('Type filter failed for candidate:', (candidate as any).constructor.name, 'expected:', type.name);
                continue;
            }

            // Apply other filters - check entity properties directly, not _data
            for (const [key, value] of Object.entries(otherFilters)) {
                // First try entity property, then fall back to _data for backward compatibility
                const entityValue = (candidate as any)[key] !== undefined
                    ? (candidate as any)[key]
                    : (candidate as any)._data[key];

                if (entityValue !== value) {
                    // console.log('Filter failed for candidate:', key, entityValue, '!==', value);
                    continue candidatesLoop;
                }
            }

            // console.log('Yielding candidate:', candidate.constructor.name, candidate.id);
            yield candidate.copy() as T;
        }

        // console.log('InMemoryStore.find generator completed');
    }

    findOne<T extends Entity<EntityData>>(filter: SearchFilter): T | undefined {
        for (const entity of this.find<T>(filter)) {
            return entity; // Return the first entity that matches the filter
        }
        return undefined; // If no entity matches the filter
    }

    clear(): void {
        // Clear all indexes while preserving the index configuration
        const { indexes } = this.indexManager.indexStorage;
        for (const index of indexes.values()) {
            index.clear();
        }
        this._loaded = false;
    }
}
