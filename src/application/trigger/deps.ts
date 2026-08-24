import type { RunActor } from "@/domain/execution/actor";
import type { RunSlotRepository } from "@/domain/execution/runSlot";
import type { EngineChunk } from "@/domain/llm/types";
import type { ProjectRepository, VersionRepository } from "@/domain/project/repository";
import type { Project, Version } from "@/domain/project/types";
import type { SecretCipher } from "@/domain/security/secretCipher";
import type { TriggerRepository } from "@/domain/trigger/repository";
import type { ScheduleDelivery } from "@/domain/trigger/types";

/** Dependencies shared by trigger firing and lost-run repair. */
export interface FiringDeps {
  triggers: TriggerRepository;
  projects: ProjectRepository;
  versions: VersionRepository;
  /** Runs the resolved version; the composition root binds the facade. */
  run: (input: {
    project: Project;
    version: Version;
    variables?: Record<string, string>;
    message?: string;
    actor: RunActor;
  }) => AsyncGenerator<EngineChunk>;
  /**
   * Reused to enforce `allowConcurrent: false` — "at most one in flight, and a
   * dead instance's hold expires" is exactly what a run slot already is.
   */
  runSlots?: RunSlotRepository;
  /** Sends a completed schedule report; platform credentials stay in the composition root. */
  deliverReport?: (project: Project, delivery: ScheduleDelivery, text: string) => Promise<void>;
}

/** The webhook path adds the cipher used to authenticate a delivery. */
export interface TriggerRunnerDeps extends FiringDeps {
  cipher: SecretCipher;
}
