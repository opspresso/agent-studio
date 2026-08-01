/**
 * The run-level context budget — the single owner of "how much may this run
 * accumulate in context".
 *
 * Every other bound is per item or per turn (tool results per turn, images per
 * turn, one transfer's transcript), so nothing watched the sum: the loop's
 * `messages` array grows every turn, a transfer's answer entered with no bound
 * at all, and the first symptom of overflow was the provider's 400 — after the
 * first chunk, an unretryable `{error}`. The budget derives a ceiling from the
 * model's own `contextWindow`, charges everything the run adds, and lets the
 * engine truncate *with a report* instead of dying without one.
 *
 * ## The approximation, recorded
 *
 * Exact token counts need each provider's tokenizer. This module deliberately
 * uses a conservative character-class estimate instead:
 *
 * - ASCII: 3 chars per token (real English averages ~4 — overestimates usage).
 * - Everything else: 2 tokens per char (Hangul/CJK reach ~2 on older
 *   tokenizers — the worst published case, so this overestimates too).
 * - An image part: a flat {@link IMAGE_PART_TOKENS}, because its `data:` URL's
 *   base64 length says nothing about what the provider charges for the image.
 *
 * Both classes round *against* the run on purpose: an overestimate truncates
 * tool output a little early and says so; an underestimate is a provider 400
 * that kills the run mid-stream. What the estimate cannot see at all — message
 * framing, tool-call envelopes, protocol overhead, small control strings the
 * engine appends unmeasured — is covered by {@link PROTOCOL_HEADROOM_TOKENS}.
 *
 * A model absent from the registry gets **no budget** (`undefined`): there is
 * no window to derive one from, and inventing a number would truncate runs
 * against a limit nobody configured. When a `fallbackModel` is configured the
 * window is the **minimum** of the two, because a mid-run fallback switch must
 * still fit what the primary had already accumulated.
 */

import { getModelConfig } from "@/domain/llm/models";
import type { ChannelMessage } from "@/domain/llm/channel";
import { cutCodePoints } from "@/shared/utf8Text";

const ASCII_CHARS_PER_TOKEN = 3;
const NON_ASCII_TOKENS_PER_CHAR = 2;
/** Flat token charge for one image content part, whatever its byte size. */
export const IMAGE_PART_TOKENS = 1_000;
/** Reserve for everything the character estimate cannot see. */
const PROTOCOL_HEADROOM_TOKENS = 2_000;

/** Conservative token estimate for a piece of text (see the module doc). */
export function estimateContextTokens(text: string): number {
  let ascii = 0;
  let wide = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) < 128) {
      ascii += 1;
    } else {
      wide += 1;
    }
  }
  return Math.ceil(ascii / ASCII_CHARS_PER_TOKEN) + wide * NON_ASCII_TOKENS_PER_CHAR;
}

export interface FittedText {
  text: string;
  /** True when the text had to be cut to fit the remaining budget. */
  truncated: boolean;
}

export interface RunContextBudget {
  /** Estimated tokens still spendable on context. Never negative. */
  remaining(): number;
  /** Record text that entered the context as-is. */
  chargeText(text: string | null | undefined): void;
  /**
   * Record a whole message: text (and `reasoning_content`, and the tool-call
   * JSON) by the character estimate, each image part at the flat image charge —
   * an inline image's base64 length would otherwise read as megatokens of text.
   */
  chargeMessage(message: ChannelMessage): void;
  /**
   * Cut text to what still fits and charge what is kept. The caller owns the
   * wording of the truncation marker — this only owns the arithmetic.
   */
  fitText(text: string): FittedText;
  /** True once any {@link fitText} call had to cut. */
  truncated(): boolean;
}

class Budget implements RunContextBudget {
  private left: number;
  private didTruncate = false;

  constructor(capacityTokens: number) {
    this.left = Math.max(0, capacityTokens);
  }

  remaining(): number {
    return this.left;
  }

  private charge(tokens: number): void {
    this.left = Math.max(0, this.left - tokens);
  }

  chargeText(text: string | null | undefined): void {
    if (text) {
      this.charge(estimateContextTokens(text));
    }
  }

  chargeMessage(message: ChannelMessage): void {
    const content = message.content;
    if (typeof content === "string") {
      this.chargeText(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === "text") {
          this.chargeText(part.text);
        } else {
          this.charge(IMAGE_PART_TOKENS);
        }
      }
    }
    this.chargeText(message.reasoning_content);
    if (message.tool_calls && message.tool_calls.length > 0) {
      this.chargeText(JSON.stringify(message.tool_calls));
    }
  }

  fitText(text: string): FittedText {
    const total = estimateContextTokens(text);
    if (total <= this.left) {
      this.charge(total);
      return { text, truncated: false };
    }
    this.didTruncate = true;
    if (this.left <= 0) {
      return { text: "", truncated: true };
    }
    // Cut proportionally, then walk down: a prefix denser in wide characters
    // than the whole can still overshoot, so the first guess is corrected
    // rather than trusted. Each step drops 10%, so this terminates fast.
    let keep = Math.floor(text.length * (this.left / total));
    let cut = cutCodePoints(text, keep);
    while (keep > 0 && estimateContextTokens(cut) > this.left) {
      keep = Math.floor(keep * 0.9);
      cut = cutCodePoints(text, keep);
    }
    this.charge(estimateContextTokens(cut));
    return { text: cut, truncated: true };
  }

  truncated(): boolean {
    return this.didTruncate;
  }
}

/**
 * The budget for one run, or `undefined` when the model is not in the registry
 * (no window to derive from — such a run stays unbudgeted, exactly as every
 * run was before the budget existed).
 *
 * The output reserve is the version's `maxTokens` when set, else the primary
 * model's registry maximum: it is what the provider may spend on the response
 * in flight, which context must leave room for on every turn.
 */
export function createRunContextBudget(
  model: string,
  fallbackModel: string | undefined,
  maxOutputTokens: number | undefined,
): RunContextBudget | undefined {
  const primary = getModelConfig(model);
  if (!primary) {
    return undefined;
  }
  const fallback = fallbackModel ? getModelConfig(fallbackModel) : undefined;
  const window = fallback
    ? Math.min(primary.contextWindow, fallback.contextWindow)
    : primary.contextWindow;
  const reserve = (maxOutputTokens ?? primary.maxTokens) + PROTOCOL_HEADROOM_TOKENS;
  return new Budget(window - reserve);
}
