/**
 * Where the model catalog comes from at runtime — a port, because the domain
 * states the catalog's shape (`models.ts`) and must not know it arrives over
 * HTTP. The adapter answers the document as parsed JSON; `loadModelCatalog`
 * is what decides whether it is a catalog.
 */
export interface ModelCatalogSource {
  /** Where the catalog is read from, for the log line. */
  readonly description: string;
  /** The catalog document, parsed but not validated. Throws when it cannot be read. */
  load(): Promise<unknown>;
}
