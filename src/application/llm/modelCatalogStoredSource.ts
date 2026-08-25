/**
 * The catalog an administrator installed by hand, as a source the refresher
 * can read — and the one rule for putting it beside the published catalog.
 *
 * An upload is an operator's explicit decision about what this deployment's
 * registry holds, so it wins over whatever the network would answer: a
 * deployment that can reach agent-models but has a document installed runs
 * on the document until the document is removed. The precedence is decided
 * on every read, not once at boot — an upload lands after boot and on any
 * instance, and a removal must let the published catalog back in on the next
 * tick without a restart.
 */

import type { ModelCatalogDocumentRepository } from "@/domain/llm/catalogDocument";
import type { ModelCatalogSource } from "@/domain/llm/modelCatalogSource";

/**
 * The stored document, when there is one. `upload.revision` is the record's
 * `uploadedAt`: the refresher re-installs only when it changes, so a document
 * whose own `updatedAt` an operator forgot to bump is still installed — the
 * upload is the event, not the stamp inside it.
 */
export function createStoredModelCatalogSource(
  repository: ModelCatalogDocumentRepository,
): ModelCatalogSource {
  let description = "operator upload";
  return {
    get description() {
      return description;
    },
    async load() {
      const record = await repository.get();
      if (record === null) {
        return undefined;
      }
      description = `operator upload (${record.uploadedBy}, ${record.uploadedAt})`;
      return { document: record.document, upload: { revision: record.uploadedAt } };
    },
  };
}

export interface CompositeModelCatalogSourceDeps {
  stored: ModelCatalogDocumentRepository;
  /**
   * The published catalog, when this deployment reads one — `undefined` when
   * `MODELS_CATALOG_URL` is unset or `none`, where the only catalogs are the
   * committed snapshot and an upload.
   */
  remote: ModelCatalogSource | undefined;
}

/**
 * Stored document first; the published catalog when there is none; nothing
 * when there is neither, which is the quiet case — the snapshot stands.
 * Composed once here so the boot refresher and the console's refresh button
 * cannot disagree about which catalog wins.
 */
export function createCompositeModelCatalogSource(
  deps: CompositeModelCatalogSourceDeps,
): ModelCatalogSource {
  const stored = createStoredModelCatalogSource(deps.stored);
  const remote = deps.remote;
  let chosen: ModelCatalogSource = stored;
  return {
    /** Whichever source the last `load()` answered from — what the log line names. */
    get description() {
      return chosen.description;
    },
    async load() {
      chosen = stored;
      const upload = await stored.load();
      if (upload !== undefined || remote === undefined) {
        return upload;
      }
      chosen = remote;
      return remote.load();
    },
  };
}
