import type { AudioJobConfig, AudioJobConfigRepository } from "@/domain/audio/config";
import { MAX_ACTIVE_AUDIO_JOBS } from "@/domain/audio/job";
import { ConflictError, ValidationError } from "@/application/errors";
import { fileExpiresAt } from "@/application/artifact/fileRetention";

export type AudioConfigInput = Pick<AudioJobConfig, "model" | "language" | "retention" | "postprocess" | "destination" | "enabled" | "maxActive" | "maxPerOccurrence">;
export function createAudioConfigUseCases(deps: {
  configs: AudioJobConfigRepository;
  authorize(agent: string, email: string): Promise<void>;
  validate(input: AudioConfigInput, agent: string, email: string): Promise<void>;
  now(): Date;
}) {
  return {
    async get(agent: string, email: string) {
      await deps.authorize(agent, email);
      return deps.configs.get(agent);
    },
    async save(agent: string, email: string, input: AudioConfigInput, revision: number) {
      await deps.authorize(agent, email);
      if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER || typeof input.enabled !== "boolean" ||
        !input.model?.trim() || (input.language !== undefined && !/^[a-z]{2,3}$/i.test(input.language)) ||
        ![input.maxActive, input.maxPerOccurrence].every((value) => Number.isSafeInteger(value) && value >= 1 && value <= MAX_ACTIVE_AUDIO_JOBS)) {
        throw new ValidationError("Invalid audio configuration limits or revision");
      }
      const now = deps.now().toISOString();
      try { fileExpiresAt(now, input.retention); } catch { throw new ValidationError("Invalid file retention"); }
      if (input.enabled) await deps.validate(input, agent, email);
      const config: AudioJobConfig = { enabled: input.enabled, model: input.model, language: input.language,
        retention: input.retention, maxActive: input.maxActive, maxPerOccurrence: input.maxPerOccurrence,
        ...(input.postprocess ? { postprocess: { agentName: input.postprocess.agentName } } : {}),
        ...(input.destination ? { destination: { serverName: input.destination.serverName,
          documents: input.destination.documents, memories: input.destination.memories } } : {}),
        agentName: agent, userEmail: email, revision: revision + 1, updatedAt: now };
      if (!await deps.configs.save(config, revision)) throw new ConflictError("Audio configuration changed");
      return config;
    },
  };
}
