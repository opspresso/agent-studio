/**
 * Trigger configuration: the owner-gated CRUD behind the console.
 *
 * The delivery path is `runTrigger.ts`; this module never runs anything.
 */

import type { RunUser } from "@/domain/execution/actor";
import type { MemberRepository } from "@/domain/member/repository";
import { tierMayEdit } from "@/domain/member/tiers";
import { nextUpdatedAt } from "@/shared/nextUpdatedAt";
import type { AgentRepository } from "@/domain/agent/repository";
import type { Agent } from "@/domain/agent/types";
import { isValidTimezone, parseCron } from "@/domain/trigger/cron";
import type { TriggerRepository } from "@/domain/trigger/repository";
import {
  AGENT_WEBHOOK_ID,
  type ScheduleDelivery,
  type ScheduleTrigger,
  type Trigger,
  type TriggerKind,
  type TriggerRun,
  type WebhookTrigger,
} from "@/domain/trigger/types";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  isConditionalWriteFailure,
} from "@/application/errors";
import { assertAgentOwner } from "@/application/agent/agentUseCases";
import { reviewRepositories, type GitHubReviewConfig } from "@/domain/trigger/pullRequestReview";
import { reviewSetupIssue } from "./reviewRequirements";

export interface TriggerDeps {
  triggers: TriggerRepository;
  agents: AgentRepository;
  members: Pick<MemberRepository, "getById">;
  /** The owning Agent must have working GitHub and Workspace infrastructure before enabling reviews. */
  assertReviewReady?: (agentName: string) => Promise<void>;
}

export interface CreateTriggerInput {
  githubReview?: GitHubReviewConfig | null;
  triggerId: string;
  /** Defaults to `webhook`. */
  kind?: TriggerKind;
  description?: string;
  enabled?: boolean;
  allowConcurrent?: boolean;
  cron?: string;
  timezone?: string;
  message?: string;
  deliveries?: ScheduleDelivery[];
}

export interface UpdateTriggerInput {
  githubReview?: GitHubReviewConfig | null;
  description?: string;
  enabled?: boolean;
  allowConcurrent?: boolean;
  cron?: string;
  timezone?: string;
  message?: string;
  deliveries?: ScheduleDelivery[];
}

/** Current trigger settings; personal credentials are managed separately. */
export interface TriggerView {
  githubReview?: GitHubReviewConfig;
  /** Current setup problem; configuration reads do not grant execution permissions. */
  reviewIssue?: string;
  createdBy?: RunUser;
  agentName: string;
  triggerId: string;
  kind: TriggerKind;
  description: string;
  enabled: boolean;
  allowConcurrent: boolean;
  createdAt: string;
  updatedAt: string;
  /** Schedule only. */
  cron?: string;
  timezone?: string;
  message?: string;
  deliveries?: ScheduleDelivery[];
}

/** Console history excludes the execution owner's private control state. */
export type TriggerRunView = Omit<TriggerRun, "runningLeaseToken" | "runningLeaseUntil">;

function toView(trigger: Trigger, agent: Agent): TriggerView {
  const reviewIssue = trigger.kind === "webhook" && trigger.githubReview ? reviewSetupIssue(agent) : undefined;
  return { ...trigger, ...(reviewIssue ? { reviewIssue } : {}) };
}

/** The cron and timezone rules, enforced where both create and update pass. */
function assertScheduleFields(input: { cron?: string; timezone?: string }): void {
  if (input.cron !== undefined && !parseCron(input.cron)) {
    throw new ValidationError(
      "cron must be a five-field cron expression (minute hour day-of-month month day-of-week)",
    );
  }
  if (input.timezone !== undefined && !isValidTimezone(input.timezone)) {
    throw new ValidationError(`Unknown timezone "${input.timezone}" — use an IANA zone name`);
  }
}

function cleanDeliveries(deliveries: readonly ScheduleDelivery[]): ScheduleDelivery[] {
  if (deliveries.length > 3) {
    throw new ValidationError("A schedule may deliver to at most three destinations");
  }
  const seen = new Set<string>();
  return deliveries.map((delivery) => {
    if (seen.has(delivery.kind)) {
      throw new ValidationError(`A schedule may name ${delivery.kind} only once`);
    }
    seen.add(delivery.kind);
    if (delivery.kind === "slack") {
      const channelId = delivery.channelId.trim();
      if (!channelId) {
        throw new ValidationError("A Slack destination needs a channel id");
      }
      return { kind: "slack", channelId };
    }
    if (delivery.kind === "telegram") {
      if (!Number.isSafeInteger(delivery.chatId) || delivery.chatId === 0) {
        throw new ValidationError("A Telegram destination needs a non-zero integer chat id");
      }
      if (
        delivery.threadId !== undefined &&
        (!Number.isSafeInteger(delivery.threadId) || delivery.threadId <= 0)
      ) {
        throw new ValidationError("A Telegram thread id must be a positive integer");
      }
      return {
        kind: "telegram",
        chatId: delivery.chatId,
        ...(delivery.threadId !== undefined ? { threadId: delivery.threadId } : {}),
      };
    }
    const conversationId = delivery.conversationId.trim();
    if (!conversationId) {
      throw new ValidationError("A Teams destination needs a conversation id");
    }
    return { kind: "teams", conversationId };
  });
}

export const TRIGGER_LIST_PAGE_SIZE = 100;

export async function listAgentTriggers(
  repo: Pick<TriggerRepository, "listByAgent">,
  agentName: string,
): Promise<Trigger[]> {
  const triggers: Trigger[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await repo.listByAgent(agentName, TRIGGER_LIST_PAGE_SIZE, after);
    triggers.push(...page);
    if (page.length < TRIGGER_LIST_PAGE_SIZE) {
      return triggers;
    }
    after = page.at(-1)!.triggerId;
  }
}

export function createTriggerUseCases(deps: TriggerDeps) {
  async function reviewConfig(value: GitHubReviewConfig | null | undefined, agentName: string): Promise<GitHubReviewConfig | undefined> {
    if (!value) return undefined;
    if (!deps.assertReviewReady) throw new ValidationError("GitHub review integration is not configured");
    await deps.assertReviewReady(agentName);
    if (value.scope === "accessible") return { scope: "accessible" };
    const repositories = value.scope === "repositories" && reviewRepositories(value.repositories);
    if (!repositories) throw new ValidationError("Select accessible repositories or a non-empty list of exact owner/repo names");
    return { scope: "repositories", repositories };
  }
  async function load(agentName: string, triggerId: string): Promise<Trigger> {
    const trigger = await deps.triggers.get(agentName, triggerId);
    if (!trigger) {
      throw new NotFoundError(`Trigger "${triggerId}" not found`);
    }
    return trigger;
  }

  return {
    async list(agentName: string, userEmail: string): Promise<TriggerView[]> {
      const agent = await assertAgentOwner(deps.agents, agentName, userEmail);
      const triggers = await listAgentTriggers(deps.triggers, agentName);
      return triggers.map((trigger) => toView(trigger, agent));
    },

    async create(
      agentName: string,
      input: CreateTriggerInput,
      userId: string,
    ): Promise<TriggerView> {
      const member = userId ? await deps.members.getById(userId) : null;
      if (!member || member.id !== userId || !tierMayEdit(member.tier)) throw new ForbiddenError("Trigger registration requires an active member account");
      const userEmail = member.email;
      const agent = await assertAgentOwner(deps.agents, agentName, userEmail);
      if (input.githubReview !== undefined && input.kind === "schedule") throw new ValidationError("GitHub reviews are only available for webhooks");
      const githubReview = await reviewConfig(input.githubReview, agentName);
      // An agent has exactly one webhook and it answers at `/api/webhook/{agent}`,
      // which resolves this id and nothing else. Both halves of that are enforced
      // here, at the only place a row is minted: a webhook under any other name
      // would have no delivery endpoint, and a schedule under this one would make
      // the delivery endpoint 404 for an agent whose console shows a webhook.
      if ((input.kind ?? "webhook") === "webhook") {
        if (input.triggerId !== AGENT_WEBHOOK_ID) {
          throw new ValidationError(
            `An agent's webhook is always "${AGENT_WEBHOOK_ID}" — it is addressed by the agent name`,
          );
        }
      } else if (input.triggerId === AGENT_WEBHOOK_ID) {
        throw new ValidationError(`"${AGENT_WEBHOOK_ID}" is reserved for the agent's webhook`);
      }
      const now = new Date().toISOString();
      const base = {
        agentName,
        triggerId: input.triggerId,
        description: input.description ?? "",
        enabled: input.enabled ?? true,
        // Overlap is off unless asked for: a firing that comes faster than the
        // run takes would otherwise pile runs up until the cost guard notices.
        allowConcurrent: input.allowConcurrent ?? false,
        createdAt: now,
        updatedAt: now,
      };
      let trigger: Trigger;
      if (input.kind === "schedule") {
        if (input.cron === undefined || input.timezone === undefined) {
          throw new ValidationError("A schedule trigger needs a cron expression and a timezone");
        }
        assertScheduleFields(input);
        trigger = {
          ...base,
          kind: "schedule",
          createdBy: { userId: member.id, email: member.email },
          cron: input.cron,
          timezone: input.timezone,
          ...(input.message ? { message: input.message } : {}),
          ...(input.deliveries?.length
            ? { deliveries: cleanDeliveries(input.deliveries) }
            : {}),
        };
      } else {
        // The same refusal update gives: cron fields on a webhook are a caller
        // who meant kind: "schedule", and dropping them would create a Webhook
        // instead of the schedule they requested.
        if (
          input.cron !== undefined ||
          input.timezone !== undefined ||
          input.message !== undefined ||
          input.deliveries !== undefined
        ) {
          throw new ValidationError("Only a schedule trigger has cron, timezone, message or deliveries");
        }
        trigger = {
          ...base,
          kind: "webhook",
          ...(githubReview ? { githubReview } : {}),
        };
      }
      if (trigger.kind === "webhook" && trigger.githubReview && trigger.enabled) {
        const issue = reviewSetupIssue(agent);
        if (issue) throw new ValidationError(issue);
      }
      try {
        await deps.triggers.create(trigger);
      } catch (error) {
        if (isConditionalWriteFailure(error, { includeTransaction: true })) {
          throw new ConflictError(`Trigger "${input.triggerId}" already exists`);
        }
        throw error;
      }
      return toView(trigger, agent);
    },

    async update(
      agentName: string,
      triggerId: string,
      input: UpdateTriggerInput,
      userEmail: string,
    ): Promise<TriggerView> {
      const agent = await assertAgentOwner(deps.agents, agentName, userEmail);
      const existing = await load(agentName, triggerId);
      if (input.githubReview !== undefined && existing.kind !== "webhook") throw new ValidationError("GitHub reviews are only available for webhooks");
      const shared = {
        description: input.description ?? existing.description,
        enabled: input.enabled ?? existing.enabled,
        allowConcurrent: input.allowConcurrent ?? existing.allowConcurrent,
        updatedAt: nextUpdatedAt(existing.updatedAt),
      };
      if (existing.kind === "schedule") {
        assertScheduleFields(input);
        // An empty string clears the message; undefined keeps what is stored.
        const { message: stored, deliveries: storedDeliveries, ...rest } = existing;
        const message = input.message ?? stored ?? "";
        const deliveries =
          input.deliveries === undefined
            ? (storedDeliveries ?? [])
            : cleanDeliveries(input.deliveries);
        const updated: ScheduleTrigger = {
          ...rest,
          ...shared,
          cron: input.cron ?? existing.cron,
          timezone: input.timezone ?? existing.timezone,
          ...(message ? { message } : {}),
          ...(deliveries.length > 0 ? { deliveries } : {}),
        };
        await deps.triggers.put(updated);
        return toView(updated, agent);
      }
      if (
        input.cron !== undefined ||
        input.timezone !== undefined ||
        input.message !== undefined ||
        input.deliveries !== undefined
      ) {
        throw new ValidationError("Only a schedule trigger has cron, timezone, message or deliveries");
      }
      const { githubReview: previousReview, ...storedWebhook } = existing;
      const githubReview = input.githubReview === undefined ? previousReview : await reviewConfig(input.githubReview, agentName);
      const updated: WebhookTrigger = {
        ...storedWebhook,
        ...shared,
        ...(githubReview ? { githubReview } : {}),
      };
      // Revocation and disabling always remain available, including broken stored setups.
      if (updated.githubReview && updated.enabled && (input.githubReview != null || input.enabled === true)) {
        const issue = reviewSetupIssue(agent);
        if (issue) throw new ValidationError(issue);
      }
      await deps.triggers.put(updated);
      return toView(updated, agent);
    },

    async remove(agentName: string, triggerId: string, userEmail: string): Promise<void> {
      await assertAgentOwner(deps.agents, agentName, userEmail);
      await load(agentName, triggerId);
      await deps.triggers.delete(agentName, triggerId);
    },

    async runs(
      agentName: string,
      triggerId: string,
      limit: number,
      userEmail: string,
    ): Promise<TriggerRunView[]> {
      // Owner-only like traces: a delivery's result preview is runtime output.
      await assertAgentOwner(deps.agents, agentName, userEmail);
      return (await deps.triggers.listRuns(agentName, triggerId, limit)).map(({ runningLeaseToken: _token, runningLeaseUntil: _lease, ...run }) => {
        void _token; void _lease;
        return run;
      });
    },
  };
}
