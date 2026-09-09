import type { AudioJobConfig, AudioJobConfigRepository } from "@/domain/audio/config";
import { keys } from "../keys";
import { projectIsLive } from "../projectLifecycle";
import { getItem, transact, CONDITIONAL_WRITE_FAILED, TRANSACTION_CANCELLED } from "../store";

export const audioJobConfigRepository: AudioJobConfigRepository = {
  async get(projectName) {
    const row = await getItem(keys.audioJobConfig(projectName));
    return row ? row.config as AudioJobConfig : null;
  },
  async save(config, expectedRevision) {
    try {
      await transact([
        { kind: "check", key: keys.project(config.projectName), condition: projectIsLive },
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
