import { slackSenderMayAccess, type SlackBotBinding } from "@/application/slack/handleSlackEvent";
import type { SlackEventBody, SlackEventDeps } from "@/application/slack/types";
import { MAX_SUGGESTED_PROMPTS } from "@/domain/slack/types";
import { log } from "@/shared/logger";

/** Only the agent catalog and the Slack client; no agent runs here. */
export type ThreadStartDeps = Pick<SlackEventDeps, "agents" | "slack">;

/**
 * Where a freshly opened agent surface is, and whether it is new.
 *
 * The two experiences announce an opening differently. `app_home_opened` fires
 * on *every* visit to the Messages tab and carries no thread, so it can only
 * (re)pin the prompts. `assistant_thread_started` fires once per new thread and
 * carries one, so it can also say hello without repeating itself.
 */
interface OpenedSurface {
  channel: string;
  threadTs?: string;
  greet: boolean;
  /** Who opened it, when the event says. The visibility gate asks. */
  userId?: string;
}

function openedSurface(body: SlackEventBody): OpenedSurface | null {
  const event = body.event;
  if (event?.type === "app_home_opened") {
    // The Home tab is a different surface entirely and has nothing to do with
    // the agent container.
    return event.tab === "messages" && event.channel
      ? { channel: event.channel, greet: false, ...(event.user ? { userId: event.user } : {}) }
      : null;
  }
  if (event?.type === "assistant_thread_started") {
    const thread = event.assistant_thread;
    return thread?.channel_id && thread.thread_ts
      ? {
          channel: thread.channel_id,
          threadTs: thread.thread_ts,
          greet: true,
          ...(thread.user_id ? { userId: thread.user_id } : {}),
        }
      : null;
  }
  return null;
}

/**
 * Answer a user opening the agent: pin this agent's suggested prompts, and on
 * a brand-new thread introduce the agent.
 *
 * Without this the agent container opens empty, which reads as a bot that is
 * not running rather than one waiting for a question.
 */
export async function handleThreadStart(
  deps: ThreadStartDeps,
  body: SlackEventBody,
  binding: SlackBotBinding,
): Promise<void> {
  const surface = openedSurface(body);
  if (!surface) {
    return;
  }
  const token = binding.botToken;
  const agent = await deps.agents.get(binding.agentName);
  // Silent, unlike a mention: nobody asked anything, so an error message here
  // would be an unprompted complaint in a thread the user just opened.
  if (!agent) {
    return;
  }
  // The same gate as a run, and silent on the same reasoning as above: the
  // greeting restates the agent's description and prompts, which is exactly
  // the read the visibility gate protects. The person's first actual message
  // gets the spoken refusal.
  if (
    !(await slackSenderMayAccess(deps, token, agent, {
      ...(surface.userId ? { user: surface.userId } : {}),
    }))
  ) {
    return;
  }

  if (surface.greet) {
    const intro = agent.description.trim();
    await deps.slack
      .postMessage(token, {
        channel: surface.channel,
        ...(surface.threadTs ? { thread_ts: surface.threadTs } : {}),
        text: intro
          ? `*${agent.displayName}*\n${intro}`
          : `*${agent.displayName}* is ready. What can I help you with?`,
      })
      .catch((error) => log.error("slack", "thread greeting failed", error));
  }

  const prompts = (agent.slack?.suggestedPrompts ?? []).slice(0, MAX_SUGGESTED_PROMPTS);
  if (prompts.length === 0) {
    return;
  }
  await deps.slack
    .setSuggestedPrompts(token, {
      channel_id: surface.channel,
      // The agent messaging experience pins prompts to the top of the Messages
      // tab and takes no thread; the legacy view scopes them to one thread.
      ...(surface.threadTs ? { thread_ts: surface.threadTs } : {}),
      prompts,
    })
    .catch((error) => log.error("slack", "suggested prompts failed", error));
}
