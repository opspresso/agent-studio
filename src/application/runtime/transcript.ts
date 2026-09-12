import type { ChatMessageInput } from "@/domain/llm/types";
import { cutCodePoints } from "@/shared/utf8Text";

const MAX_TRANSFER_CONTEXT_CHARS = 8_000;
/**
 * Below this, a truncated turn says nothing useful and is worse than admitting
 * it was omitted — the child reads half a sentence as if it were the whole one.
 */
const MIN_TRANSFER_LINE_CHARS = 500;

/**
 * One message as a single transcript line.
 *
 * Named apart from `messageText` in `domain/llm/types.ts` on purpose: that one
 * declares itself the single owner of "the words of a turn" and answers a
 * different question — it *drops* image parts and joins on newlines, because its
 * readers are a template, a prompt and a catalog search query.
 *
 * A transcript is neither. A turn that carried only a picture is not an empty
 * turn to the child reading it, so the image is named; and the result is one
 * line of a line-oriented budget, so it joins on spaces and trims. Sharing an
 * implementation here would make an image-only turn vanish from the transcript,
 * and sharing the *name* is what would make that look like a safe edit.
 */
function transcriptLine(content: ChatMessageInput["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => (part.type === "text" ? part.text : "[image]"))
    .join(" ")
    .trim();
}

/**
 * The conversation so far, as text a transferred agent can read.
 *
 * Deliberately NOT replayed as messages. A child is a different agent with its
 * own system prompt: handed the parent's `assistant` turns it reads them as its
 * own ("as I already said"), and the parent's `tool_calls` would arrive naming
 * tools the child never declared. A labelled block inside the child's single
 * user turn has neither problem, and it is the one form a remote/A2A child —
 * which can only be sent text — can receive too.
 *
 * Spent newest-first, because a follow-up is usually about the turn just before
 * it, then flipped back into reading order.
 *
 * The turn being answered is excluded: the transfer message the model wrote is
 * already this request, so including it would hand the child the same thing
 * twice — and a conversation of one turn would carry a "conversation so far"
 * that is only itself. What remains is what the request cannot say on its own.
 */
export function buildTransferTranscript(
  messages: ChatMessageInput[],
  assistantLabel: string,
): { text: string; dropped: number } {
  const lines: string[] = [];
  let budget = MAX_TRANSFER_CONTEXT_CHARS;
  let dropped = 0;
  const prior = messages.at(-1)?.role === "user" ? messages.length - 1 : messages.length;
  for (let i = prior - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || (message.role !== "user" && message.role !== "assistant")) {
      continue;
    }
    const text = transcriptLine(message.content);
    if (!text) {
      continue;
    }
    const line = `${message.role === "user" ? "User" : assistantLabel}: ${text}`;
    if (line.length > budget) {
      // One turn larger than the whole remaining budget. Dropping it outright
      // loses the *question* along with whatever made it long — a turn carrying
      // an attached document is a single line of tens of thousands of
      // characters. Keeping its head preserves what the turn was about.
      // Keeping its head keeps what the turn was about; the budget is spent
      // either way, so nothing older fits after this.
      if (budget > MIN_TRANSFER_LINE_CHARS) {
        lines.push(`${cutCodePoints(line, budget)}…[truncated]`);
        budget = 0;
      }
      dropped += 1;
      continue;
    }
    budget -= line.length;
    lines.push(line);
  }
  if (lines.length === 0) {
    return { text: "", dropped };
  }
  lines.reverse();
  // Said in the transcript itself, not only in the run's warnings: the child
  // never sees those, and a gap it cannot see is one it will answer around.
  if (dropped > 0) {
    lines.unshift(`…(${dropped} earlier turn(s) omitted)`);
  }
  return { text: lines.join("\n"), dropped };
}

