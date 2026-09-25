import type { AudioJobConfig, AudioJobConfigRepository } from "@/domain/audio/config";
import { keys } from "../keys";
import { agentIsLive } from "../agentLifecycle";
import { getItem, transact, type TransactOp, CONDITIONAL_WRITE_FAILED, TRANSACTION_CANCELLED } from "../store";

export const audioJobConfigRepository: AudioJobConfigRepository = {
  async get(agentName) {
    const row = await getItem(keys.audioJobConfig(agentName));
    return row ? row.config as AudioJobConfig : null;
  },
  async save(config, expectedRevision) {
    const reference = config.enabled ? config.postprocess : undefined;
    const referenceChecks: TransactOp[] = reference ? [{
      kind: "check", key: keys.agent(reference.agentName),
      condition: row => agentIsLive(row) && row?.ownerEmail === config.userEmail && !!row.configuration,
    }] : [];
    try {
      await transact([
        { kind: "check", key: keys.agent(config.agentName), condition: agentIsLive },
        ...referenceChecks,
        { kind: "put", item: { ...keys.audioJobConfig(config.agentName), entityType: "AudioJobConfig", config },
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
