/**
 * A model catalog an administrator installed by hand — the way a deployment
 * with no route to agent-models' published catalog gets one. One document per
 * deployment: the most recent upload is the catalog, until it is removed.
 */
export interface ModelCatalogDocumentRecord {
  /** The catalog as uploaded, parsed but otherwise untouched. */
  document: unknown;
  /** Who installed it, by the address their session authenticated as. */
  uploadedBy: string;
  /** ISO-8601; also what identifies one upload from the next. */
  uploadedAt: string;
}

export interface ModelCatalogDocumentRepository {
  get(): Promise<ModelCatalogDocumentRecord | null>;
  put(record: ModelCatalogDocumentRecord): Promise<void>;
  /** A no-op when nothing is stored. */
  delete(): Promise<void>;
}
