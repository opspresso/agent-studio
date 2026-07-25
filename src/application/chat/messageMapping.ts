import type {
  AssistantChatMessage,
  ChatMessage,
  ToolChatMessage,
  UserChatMessage,
} from "@/domain/chat/types";
import type { ChannelToolCall, ChatMessageInput } from "@/domain/llm/types";

/**
 * How many earlier assistant turns replay their tool calls and results. Without
 * any, a follow-up question ("what was in the second row?") reaches a model that
 * cannot see what the tool returned, so it calls the tool again — or says it
 * cannot tell. Replaying *every* turn is the other failure: tool output is the
 * bulkiest thing in a chat, and it would crowd out the conversation itself.
 */
const DEFAULT_TOOL_REPLAY_TURNS = 3;

/**
 * Total replayed tool text. Spent newest-first, because the turn just before
 * the question is the one it is usually about. A single stored result may be
 * 100KB on its own, so without this the last few turns alone could fill the
 * whole context window.
 */
const MAX_REPLAYED_TOOL_CHARS = 20_000;

/**
 * How much of the conversation itself replays. A chat is stored in full and
 * grows without limit, so an old enough one eventually exceeds what a request
 * can carry and every further message fails — after the bill for resending the
 * whole history has already been paid, turn after turn.
 *
 * Generous on purpose: an ordinary chat never reaches either bound, and what is
 * dropped is reported rather than silently lost.
 */
const MAX_HISTORY_CHARS = 200_000;
const MAX_HISTORY_MESSAGES = 200;

/**
 * A stored user turn: text, or content parts when the turn carried attachments.
 * The stored images are object-storage URLs (the provider fetches them), so a
 * replayed attachment is visible to the model but not editable — only the turn
 * that uploaded it had the bytes in hand.
 */
function userMessage(message: UserChatMessage): ChatMessageInput {
  const images = message.images ?? [];
  if (images.length === 0) {
    return { role: "user", content: message.content };
  }
  return {
    role: "user",
    content: [
      ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
      ...images.map((image) => ({
        type: "image_url" as const,
        image_url: { url: image.url },
      })),
    ],
  };
}

/** One stored call and the result stored for it, already matched. */
interface ToolPair {
  call: ChannelToolCall;
  content: string;
}

/**
 * Split storage into runs. A user message starts one and everything written
 * until the next user message belongs to it — which is exactly one run, since a
 * run is what a user message triggers.
 *
 * The split is what makes id matching safe: a tool-call id is only unique
 * within the run that produced it (a provider that omits ids has them
 * synthesized, and the counter restarts each run), so matching across the whole
 * chat would let a later run's result answer an earlier run's call.
 */
function toRuns(messages: ChatMessage[]): ChatMessage[][] {
  const runs: ChatMessage[][] = [];
  let current: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === "user" && current.length > 0) {
      runs.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) {
    runs.push(current);
  }
  return runs;
}

/**
 * Keep the newest runs that fit the history bounds. Whole runs, so a kept
 * assistant message never loses the user turn it answered or the tool rows it
 * declared. The newest run is always kept, even alone over budget: a request
 * without the question is worse than a long one.
 */
function withinHistoryBudget(runs: ChatMessage[][]): { kept: ChatMessage[][]; dropped: number } {
  const kept: ChatMessage[][] = [];
  let chars = 0;
  let count = 0;
  let dropped = 0;
  let full = false;
  for (const run of [...runs].reverse()) {
    const size = run.reduce((total, message) => total + message.content.length, 0);
    if (full || (kept.length > 0 && (chars + size > MAX_HISTORY_CHARS || count + run.length > MAX_HISTORY_MESSAGES))) {
      full = true;
      dropped += 1;
      continue;
    }
    chars += size;
    count += run.length;
    kept.unshift(run);
  }
  return { kept, dropped };
}

/**
 * Match one run's stored calls to its stored results. Order-tolerant: storage
 * writes `tool… → assistant`, the reverse of the wire format, and a row is
 * claimed by the first unmatched call carrying its id — so even a run that
 * synthesized the same id twice pairs each call with its own result.
 */
function pairWithinRun(run: ChatMessage[], into: Map<ChatMessage, ToolPair[]>): void {
  const available = run.filter((message): message is ToolChatMessage => message.role === "tool");
  for (const message of run) {
    if (message.role !== "assistant") {
      continue;
    }
    const pairs: ToolPair[] = [];
    for (const call of message.toolCalls ?? []) {
      if (!call.id) {
        continue;
      }
      const index = available.findIndex((row) => row.toolCallId === call.id);
      if (index < 0) {
        continue;
      }
      const [row] = available.splice(index, 1);
      if (!row) {
        continue;
      }
      pairs.push({ call, content: row.content });
    }
    if (pairs.length > 0) {
      into.set(message, pairs);
    }
  }
}

export interface ToEngineMessagesOptions {
  /** Assistant turns whose tool calls replay. 0 replays none. */
  toolReplayTurns?: number;
}

export interface EngineMessages {
  messages: ChatMessageInput[];
  /** What the history could not carry; the run reports these to the user. */
  warnings: string[];
}

/**
 * Convert stored chat messages to OpenAI-shaped engine messages.
 *
 * Tool rows are not emitted where they sit: each is paired with the assistant
 * message that declared its call, within the run both belong to, and emitted
 * right after it. A row with no matching call — a subagent's, or one from a run
 * too old to replay — is kept in storage for display and dropped here, and a
 * call whose result is missing is dropped from the assistant message rather
 * than left as an orphan the provider would reject.
 */
export function toEngineMessages(
  messages: ChatMessage[],
  options: ToEngineMessagesOptions = {},
): EngineMessages {
  const replayTurns = options.toolReplayTurns ?? DEFAULT_TOOL_REPLAY_TURNS;
  const { kept, dropped } = withinHistoryBudget(toRuns(messages));
  const history = kept.flat();

  const pairedByMessage = new Map<ChatMessage, ToolPair[]>();
  for (const run of kept) {
    pairWithinRun(run, pairedByMessage);
  }

  // Newest-first so the budget is spent on the turns a follow-up is most likely
  // about; a call that no longer fits is dropped with its result.
  const replayable = history.filter(
    (message): message is AssistantChatMessage => pairedByMessage.has(message),
  );
  // Guarded rather than `slice(-replayTurns)`: `slice(-0)` is `slice(0)`, which
  // would replay everything for the one option value that means "replay none".
  const recent = replayTurns > 0 ? replayable.slice(-replayTurns) : [];
  const replayed = new Map<ChatMessage, ToolPair[]>();
  let budget = MAX_REPLAYED_TOOL_CHARS;
  for (const message of [...recent].reverse()) {
    const pairs: ToolPair[] = [];
    for (const pair of pairedByMessage.get(message) ?? []) {
      if (budget <= 0) {
        break;
      }
      const text = pair.content.slice(0, budget);
      budget -= text.length;
      pairs.push({
        call: pair.call,
        content: text.length < pair.content.length ? `${text}\n…[truncated]` : text,
      });
    }
    if (pairs.length > 0) {
      replayed.set(message, pairs);
    }
  }

  const out: ChatMessageInput[] = [];
  for (const message of history) {
    if (message.role === "user") {
      out.push(userMessage(message));
      continue;
    }
    if (message.role === "tool") {
      continue; // emitted with the assistant message that declared it
    }
    const pairs = replayed.get(message) ?? [];
    const mapped: ChatMessageInput = { role: "assistant", content: message.content };
    if (pairs.length > 0) {
      mapped.tool_calls = pairs.map((pair) => pair.call);
    }
    out.push(mapped);
    for (const pair of pairs) {
      out.push({ role: "tool", content: pair.content, tool_call_id: pair.call.id as string });
    }
  }

  return {
    messages: out,
    warnings:
      dropped > 0
        ? [
            `${dropped} earlier turn(s) were left out of this answer's context: the chat is longer than one request can carry.`,
          ]
        : [],
  };
}
