import { fileReferenceText } from "@/application/artifact/producedFiles";
import type {
  AssistantChatMessage,
  ChatMessage,
  ToolChatMessage,
  UserChatMessage,
} from "@/domain/chat/types";
import type { ChannelToolCall, ChatMessageInput } from "@/domain/llm/types";
import { isInlineImageDataUrl } from "@/domain/llm/imageLimits";
import { turnContent } from "@/application/llm/documentParts";
import { cutCodePoints } from "@/shared/utf8Text";

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
 * Stored image references have already been resolved upstream. Run replay
 * restores the newest objects as data URLs so they remain editable; anything
 * else is absent from the run context rather than fetched by the provider.
 */
function userMessage(message: UserChatMessage, imagesDropped: boolean): ChatMessageInput {
  const documents = message.documents ?? [];
  // Resolved upstream (`resolveImages.ts`); one that could not be restored
  // carries no URL and is left out rather than handed to the provider.
  const images = (message.images ?? []).flatMap((image) =>
    image.url && isInlineImageDataUrl(image.url)
      ? [{ type: "image_url" as const, image_url: { url: image.url } }]
      : [],
  );
  // A turn whose whole content was an image replays as an empty user message
  // once that image can no longer be addressed — a shape some providers refuse
  // outright and none can make anything of. The marker keeps the conversation
  // well-formed and puts the loss where the model will read it, which is the
  // same thing a truncated tool result does.
  //
  // Conditioned on the turn having *had* images, not on it being empty: a turn
  // stored with no content and no attachments replays empty because that is
  // what it was, and telling the model an image went missing from it would be
  // inventing the loss rather than reporting one.
  const lostEveryImage = images.length === 0 && (imagesDropped || (message.images?.length ?? 0) > 0);
  const content =
    !message.content && documents.length === 0 && lostEveryImage
      ? "[The image(s) attached to this turn are no longer available.]"
      : message.content;
  return {
    role: "user",
    // Assembled by the same function the turn was sent with: a replay shaped
    // differently would be a different turn than the one this chat recorded.
    content: turnContent(documents, content, images),
  };
}

function assistantImageMessage(message: AssistantChatMessage): ChatMessageInput | undefined {
  const images = (message.images ?? []).flatMap((image) =>
    image.url && isInlineImageDataUrl(image.url)
      ? [{ type: "image_url" as const, image_url: { url: image.url } }]
      : [],
  );
  if (images.length === 0) {
    return undefined;
  }
  return {
    role: "user",
    content: [
      { type: "text", text: "[Image produced in the preceding assistant answer.]" },
      ...images,
    ],
  };
}

/** What a stored message costs the history budget, attachments included. */
function messageChars(message: ChatMessage): number {
  const documents = message.role === "user" ? (message.documents ?? []) : [];
  const files = message.role === "assistant" ? fileReferenceText((message.files ?? []).map((file) => ({ name: file.name, fileId: file.artifactId }))).length : 0;
  return documents.reduce((total, document) => total + document.text.length, message.content.length + files);
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
    // Document text counts. It is stored beside `content` rather than in it, so
    // measuring `content` alone would price a turn carrying 40,000 characters of
    // PDF as though it were the sentence the user typed, and the budget this
    // exists to keep would be spent without ever being charged.
    const size = run.reduce((total, message) => total + messageChars(message), 0);
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
  // `displayOnly` rows are excluded outright: a subagent's result and a
  // transfer's marker are stored so a reader can see what ran, but neither is
  // the answer to the call it sits next to.
  const available = run.filter(
    (message): message is ToolChatMessage => message.role === "tool" && !message.displayOnly,
  );
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
  /** Image loss reported before unresolved references were removed. */
  droppedImageSeqs?: ReadonlySet<number>;
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
      // `cutCodePoints`, not `slice`: this text is replayed into the model's
      // context, and a cut between the halves of a non-BMP character sends a
      // lone surrogate to the provider.
      const text = cutCodePoints(pair.content, budget);
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
      out.push(userMessage(message, options.droppedImageSeqs?.has(message.seq) ?? false));
      continue;
    }
    if (message.role === "tool") {
      continue; // emitted with the assistant message that declared it
    }
    const pairs = replayed.get(message) ?? [];
    // `message.reasoning` is deliberately left off. A run writes one assistant
    // message holding every turn's text, so putting the flattened thinking back
    // as `reasoning_content` would claim one block belonged to a message whose
    // `tool_calls` came from several turns. It is also unbudgeted here —
    // `messageChars` counts content and document text, not this — so replaying
    // it would overrun the window without the "earlier turn(s) were left out"
    // warning below ever firing.
    const fileIds = fileReferenceText((message.files ?? []).map((file) => ({ name: file.name, fileId: file.artifactId })));
    const content = message.content + (fileIds ? `\n${fileIds}` : "");
    const mapped: ChatMessageInput = { role: "assistant", content };
    if (pairs.length > 0) {
      mapped.tool_calls = pairs.map((pair) => pair.call);
    }
    // A turn can now be stored with an empty answer — a run that only thought,
    // which is the whole shape of a model that answers inside its reasoning.
    // Replaying it would put `{ role: "assistant", content: "" }` with no tool
    // calls into every later request, and the gateways in front of Anthropic
    // and Bedrock reject an empty assistant block: one such turn would fail
    // the *next* send and every one after it.
    if (mapped.content !== "" || mapped.tool_calls) {
      out.push(mapped);
    }
    for (const pair of pairs) {
      out.push({ role: "tool", content: pair.content, tool_call_id: pair.call.id as string });
    }
    const imageMessage = assistantImageMessage(message);
    if (imageMessage) {
      // OpenAI-compatible providers do not consistently accept image parts on
      // assistant messages. A following user image message preserves ordering
      // while keeping the generated picture in a portable content shape.
      out.push(imageMessage);
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
