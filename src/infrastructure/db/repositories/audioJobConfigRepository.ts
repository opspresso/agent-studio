import type { AudioJobConfig, AudioJobConfigRepository } from "@/domain/audio/config";
import { keys } from "../keys";
import { projectIsLive } from "../projectLifecycle";
import { getItem, transact, conditions, type TransactOp, CONDITIONAL_WRITE_FAILED, TRANSACTION_CANCELLED } from "../store";
import { nextUpdatedAt } from "@/shared/nextUpdatedAt";

export const audioJobConfigRepository: AudioJobConfigRepository = {
  async get(projectName) {
    const row = await getItem(keys.audioJobConfig(projectName));
    return row ? row.config as AudioJobConfig : null;
  },
  async save(config, expectedRevision) {
    const reference = config.enabled ? config.postprocess : undefined;
    const target = reference ? await getItem(keys.project(reference.projectName)) : null;
    const versionName = reference?.versionName === "published" ? target?.publishedVersion : reference?.versionName;
    if (reference && typeof versionName !== "string") return false;
    const referenceChecks: TransactOp[] = reference ? [
      // Share the version deletion's project fence. A save that lands after its
      // reference scan invalidates the deletion's expected project timestamp.
      { kind: "update", key: keys.project(reference.projectName),
        condition: (row) => projectIsLive(row) && row?.ownerEmail === config.userEmail &&
          (reference.versionName !== "published" || row.publishedVersion === versionName),
        patch: (row) => ({ ...row, updatedAt: nextUpdatedAt(String(row?.updatedAt ?? ""), Date.parse(config.updatedAt)) }) },
      // If deletion won first, the recipe must not be stored with a missing target.
      { kind: "check", key: keys.version(reference.projectName, versionName as string), condition: conditions.exists },
    ] : [];
    try {
      await transact([
        { kind: "check", key: keys.project(config.projectName), condition: projectIsLive },
        ...referenceChecks,
        { kind: "put", item: { ...keys.audioJobConfig(config.projectName), entityType: "AudioJobConfig", config },
          condition: (row) => expectedRevision === 0 ? row === null
            : (row?.config as AudioJobConfig | undefined)?.revision === expectedRevision },
      ]);
      return true;
    } catch (error) {
      if (error instanceof Error && [CONDITIONAL_WRITE_FAILED, TRANSACTION_CANCELLED].includes(error.name)) return false;
      throw error;
    }
  },
};
