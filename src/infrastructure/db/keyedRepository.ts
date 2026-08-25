import { conditions, deleteItem, getItem, putItem, queryItems } from "./store";
import { keys } from "./keys";
import { boundedPageLimit } from "@/shared/pageLimit";

/**
 * CRUD over a name-keyed registry entity (single-item partition, SK `META`)
 * listed via its GSI1 `TYPE#<entityType>` partition. The `toItem`/`fromItem`
 * mappers stay per-repository — they carry the entity-specific fields.
 */
export function createKeyedRepository<T extends { name: string }>(opts: {
  entityType: Parameters<typeof keys.typePartition>[0];
  key(name: string): { PK: string; SK: string };
  toItem(entity: T): Record<string, unknown>;
  fromItem(item: Record<string, unknown>): T;
}): {
  get(name: string): Promise<T | null>;
  list(limit: number, after?: string): Promise<T[]>;
  create(entity: T): Promise<void>;
  update(entity: T): Promise<void>;
  put(entity: T): Promise<void>;
  delete(name: string): Promise<void>;
} {
  return {
    async get(name) {
      const item = await getItem(opts.key(name));
      return item ? opts.fromItem(item) : null;
    },

    async list(limit, after) {
      const items = await queryItems({
        index: "GSI1",
        pk: keys.typePartition(opts.entityType),
        limit: boundedPageLimit(limit),
        ...(after ? { after } : {}),
      });
      return items.map((item) => {
        const entity = opts.fromItem(item);
        if (entity.name !== item.GSI1SK) {
          throw new Error(`${opts.entityType} registry row name does not match its index key`);
        }
        return entity;
      });
    },

    async put(entity) {
      await putItem(opts.toItem(entity));
    },

    async create(entity) {
      await putItem(opts.toItem(entity), conditions.notExists);
    },

    async update(entity) {
      await putItem(opts.toItem(entity), conditions.exists);
    },

    async delete(name) {
      await deleteItem(opts.key(name), conditions.exists);
    },
  };
}
