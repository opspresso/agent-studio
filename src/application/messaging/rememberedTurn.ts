import { turnContent } from "@/application/llm/documentParts";
import { messageText } from "@/domain/llm/types";
import { conversationKey, type RunActor, type RunCaller, type RunConversation } from "@/domain/execution/actor";
import type { InboundAttachment } from "@/domain/messaging/inbound";
import type { ReplyChannel } from "@/domain/messaging/reply";
import type { ConversationTranscriptRepository } from "@/domain/messaging/transcript";
import type { Project, AgentConfiguration } from "@/domain/project/types";
import type { LogScope } from "@/shared/logger";
import { handleTurn, type MessagingDeps, type TurnOutcome } from "./handleTurn";
import {
  answerNote,
  attachmentNote,
  loadTranscriptHistory,
  rememberTurn,
  withSpeakerLabels,
} from "./transcriptHistory";

/**
 * The turn a chat-bot surface with **no platform history** runs: the same
 * pipeline as every other, wrapped in what such a surface has to do around it
 * — read the conversation it remembers before the run, and write both new
 * turns down after. Telegram and Teams are two of them, and the wrapping was
 * identical down to the comments; a third copy is what this exists to prevent.
 *
 * What the adapter still decides is what it alone knows: who the person is
 * (`userId`, `callerOf`), what the message carried (`attachments`), when it
 * arrived, and where the reply goes.
 */

/** The deps such a surface carries: the shared bag plus the store it remembers with. */
export type RememberedTurnDeps = MessagingDeps & { transcripts?: ConversationTranscriptRepository };

export interface RememberedTurnInput {
  project: Project;
  configuration: AgentConfiguration;
  reply: ReplyChannel;
  conversation: RunConversation;
  /** What the person wrote, mention markup already removed; empty when only files came. */
  text: string;
  attachments: InboundAttachment[];
  actor?: RunActor;
  /** The platform's id for the person, for the transcript and the speaker labels. */
  userId?: string;
  /**
   * Who is asking, resolved only when the Agent asked to know: the opt-in
   * gates the lookup, the prompt, and what is written down.
   */
  callerOf: () => RunCaller | undefined;
  /**
   * When the message arrived — the platform's own instant, not this
   * process's. Two messages answered concurrently must be remembered in the
   * order they were said, not the order their runs finished.
   */
  arrivedAt: Date;
  /** What the surface already lost before the run; the pipeline appends its own. */
  warnings: string[];
  scope: LogScope;
}

/** Resolve the Agent and its current settings before accepting a messaging turn. */
export async function resolveAgentProject(
  deps: MessagingDeps,
  projectName: string,
  reply: ReplyChannel,
): Promise<{ project: Project; configuration: AgentConfiguration } | null> {
  const project = await deps.projects.get(projectName);
  const configuration = project ? project.configuration : null;
  if (!project || !configuration) {
    await reply.say(
      `Agent project not available: ${projectName} (must exist and have current Agent settings)`,
    );
    return null;
  }
  return { project, configuration };
}

export async function runRememberedTurn(
  deps: RememberedTurnDeps,
  input: RememberedTurnInput,
): Promise<TurnOutcome> {
  const { project, configuration, reply, conversation, warnings, scope } = input;
  const key = conversationKey(conversation);
  // Read before anything is written, like the Slack thread: the reply must
  // not come back as an assistant turn in this run's own context.
  const remembered = await loadTranscriptHistory(deps.transcripts, project.name, key, warnings, scope);
  await reply.status("is thinking…");

  // The Agent's opt-in gates whether a name reaches the model, and so
  // whether one is written down beside the turn at all — and whether one an
  // earlier run wrote down is read back.
  const namesAllowed = configuration.parameters.callerContext === true;
  const named = namesAllowed ? input.callerOf() : undefined;
  const { history, label } = withSpeakerLabels(remembered, input.userId, namesAllowed);
  // Labelled only when there is text to label: a name on its own is not a
  // question, and it would carry a message that has nothing to ask past the
  // guard that keeps such a message from dispatching.
  const askText = label && named && input.text ? `${named.displayName}: ${input.text}` : input.text;

  const outcome = await handleTurn(
    deps,
    {
      project,
      configuration,
      text: askText,
      attachments: input.attachments,
      history,
      ...(input.actor ? { actor: input.actor } : {}),
      ...(named ? { caller: named } : {}),
      conversation,
      warnings,
    },
    reply,
  );

  // Written after the reply, because that is what makes it true — and stamped
  // with when the question *arrived*, so two questions answered side by side
  // are remembered in the order they were asked. The answer follows its
  // question by a millisecond. A turn that carried no text is written down as
  // what it carried, and an answer that had none as what it delivered, so the
  // exchange keeps its shape.
  const askedAt = input.arrivedAt.toISOString();
  await rememberTurn(
    deps.transcripts,
    project.name,
    key,
    {
      role: "user",
      content: messageText({ content: turnContent(outcome.inputDocuments ?? [], input.text) }) ||
        attachmentNote(input.attachments.map((attachment) => attachment.name)),
      ...(input.userId ? { userId: input.userId } : {}),
      ...(named ? { speaker: named.displayName } : {}),
      createdAt: askedAt,
    },
    scope,
  );
  await rememberTurn(
    deps.transcripts,
    project.name,
    key,
    {
      role: "assistant",
      content: outcome.text || answerNote(outcome),
      createdAt: new Date(input.arrivedAt.getTime() + 1).toISOString(),
    },
    scope,
  );
  return outcome;
}
