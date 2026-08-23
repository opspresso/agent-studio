import type {
  ModelCatalogDocumentRecord,
  ModelCatalogDocumentRepository,
} from "@/domain/llm/catalogDocument";
import { deleteItem, getItem, putItem } from "../store";
import { keys } from "../keys";

const ENTITY_TYPE = "MODELCATALOG" as const;

/**
 * The uploaded catalog, one row at a fixed address. The document rides in the
 * row as it was uploaded — the store is JSONB, so a 4MB catalog is an ordinary
 * row — and is read back untouched: what the registry installs is what the
 * admin sent, not a re-encoding of it.
 */
export const modelCatalogRepository: ModelCatalogDocumentRepository = {
  async get() {
    const item = await getItem(keys.modelCatalog());
    if (!item) {
      return null;
    }
    return {
      document: item.document,
      uploadedBy: item.uploadedBy as string,
      uploadedAt: item.uploadedAt as string,
    };
  },

  async put(record: ModelCatalogDocumentRecord) {
    await putItem({
      ...keys.modelCatalog(),
      entityType: ENTITY_TYPE,
      document: record.document,
      uploadedBy: record.uploadedBy,
      uploadedAt: record.uploadedAt,
    });
  },

  async delete() {
    await deleteItem(keys.modelCatalog());
  },
};
