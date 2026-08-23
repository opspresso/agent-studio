/**
 * Where the model catalog comes from at runtime — a port, because the domain
 * states the catalog's shape (`models.ts`) and must not know it arrives over
 * HTTP or out of a row an admin wrote. The adapter answers the document as
 * parsed JSON; `loadModelCatalog` is what decides whether it is a catalog.
 */

/** One read of a source: the document, and whose intent it carries. */
export interface ModelCatalogRead {
  /** The catalog document, parsed but not validated. */
  document: unknown;
  /**
   * Present when the document is an operator's explicit install rather than
   * a publisher's: the refresher installs it whatever its `updatedAt` says
   * and without the shrink guard — both protect against a *publish* that
   * lagged or truncated, and an upload is neither — and re-installs it only
   * when `revision` changes, which is how the hourly tick stays quiet.
   */
  upload?: { revision: string };
}

export interface ModelCatalogSource {
  /** Where the catalog is read from, for the log line. */
  readonly description: string;
  /**
   * The catalog, or `undefined` when the source has nothing to offer — an
   * air-gapped deployment with no upload yet, where the registry stands as it
   * is and nothing is wrong. Throws when it *should* have answered and could
   * not.
   */
  load(): Promise<ModelCatalogRead | undefined>;
}
