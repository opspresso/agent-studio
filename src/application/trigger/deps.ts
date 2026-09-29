import type { RunActor } from "@/domain/execution/actor";
import type { RunSlotRepository } from "@/domain/execution/runSlot";
import type { EngineChunk, McpToolResult } from "@/domain/llm/types";
import type { AgentRepository } from "@/domain/agent/repository";
import type { Agent, AgentConfiguration } from "@/domain/agent/types";
import type { SecretCipher } from "@/domain/security/secretCipher";
import type { TriggerRepository } from "@/domain/trigger/repository";
import type { ScheduleDelivery } from "@/domain/trigger/types";
import type { PullRequestReviewForge } from "@/domain/trigger/pullRequestReview";
import type { PullRequestReviewTarget, ReviewWorkspaceSession, ReviewWorkspaceTool } from "@/domain/trigger/pullRequestReview";

/** Dependencies shared by trigger firing and lost-run repair. */
export interface FiringDeps {
  triggers: TriggerRepository;
  agents: AgentRepository;
  /** Runs the resolved Agent; the composition root binds the facade. */
  run: (input: {
    agent: Agent;
    configuration: AgentConfiguration;
    message?: string;
    actor: RunActor;
    userEmail?: string;
    signal?: AbortSignal;
    /** Bound skills only; verified PRs additionally receive their private source and Workspace callbacks. */
    backgroundTask?: boolean;
    reviewSource?: (args: Record<string, unknown>) => Promise<McpToolResult>;
    reviewWorkspace?: ReviewWorkspaceTool;
  }) => AsyncGenerator<EngineChunk>;
  /**
   * Reused to enforce `allowConcurrent: false` — "at most one in flight, and a
   * dead instance's hold expires" is exactly what a run slot already is.
   */
  runSlots?: RunSlotRepository;
  executionUserActive?: (email: string) => Promise<boolean>;
  /** Sends a completed schedule report; platform credentials stay in the composition root. */
  deliverReport?: (agent: Agent, delivery: ScheduleDelivery, text: string) => Promise<void>;
}

/** The webhook path adds the cipher used to authenticate a delivery. */
export interface TriggerRunnerDeps extends FiringDeps {
  openReviewWorkspace?: (target: PullRequestReviewTarget, agentName: string, triggerId: string, ownerEmail?: string) => Promise<ReviewWorkspaceSession>;
  cipher: SecretCipher;
  reviewForge?: () => PullRequestReviewForge;
}
