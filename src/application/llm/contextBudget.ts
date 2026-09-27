/**
 * Context accounting from registered model windows and output reserves.
 * Estimate ASCII at three UTF-16 units per token, non-ASCII at 1.5 tokens per
 * unit, plus flat image and protocol charges. This is a heuristic, not a
 * provider tokenizer. Fits reserve truncation markers; forced protocol text
 * remains charged after exhaustion. Fallback uses the smaller input capacity.
 */

import { getModelConfig, type ModelConfig } from "@/domain/llm/models";
import type { ChannelMessage } from "@/domain/llm/channel";
import { cutCodePoints } from "@/shared/utf8Text";

const ASCII_CHARS_PER_TOKEN = 3;
/** Applied as ×3/2 so the arithmetic stays in integers. */
const NON_ASCII_TOKENS_PER_2_CHARS = 3;
/** Flat platform estimate for an image part; actual provider token usage can differ. */
export const IMAGE_PART_TOKENS = 2_500;
/** Reserve for everything the character estimate cannot see. */
export const PROTOCOL_HEADROOM_TOKENS = 2_000;

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
  return (
    Math.ceil(ascii / ASCII_CHARS_PER_TOKEN) + Math.ceil((wide * NON_ASCII_TOKENS_PER_2_CHARS) / 2)
  );
}

export interface FitOptions {
  /**
   * Appended to the text whenever it is cut — the truncation marker. Reserved
   * *before* the cut point is chosen and charged with what is kept, so the
   * marker itself can never push the message past the budget.
   */
  suffix?: string;
  /**
   * Below this many kept characters a cut text reads as data while carrying
   * none — the caller substitutes its own omission text instead (and charges
   * it; see {@link RunContextBudget.chargeText}).
   */
  minKeepChars?: number;
}

export interface FittedText {
  /** What to insert: the text, with the suffix already appended on a cut. */
  text: string;
  /** True when the text had to be cut to fit the remaining budget. */
  truncated: boolean;
  /**
   * False when nothing worth keeping fit (the budget is exhausted, or the cut
   * fell under `minKeepChars`). Nothing was charged; `text` is empty and the
   * caller substitutes and charges its own omission text.
   */
  kept: boolean;
}

export interface RunContextBudget {
  snapshot(): { left: number; truncated: boolean };
  /** Estimated tokens still spendable on context. Never negative. */
  remaining(): number;
  /**
   * Record text that entered the context as-is. Charges past zero into debt,
   * so a string the tool protocol forces in after exhaustion (an omission
   * error — a tool call must have a result message) is still counted rather
   * than silently widening the gap between the estimate and the wire.
   */
  chargeText(text: string | null | undefined): void;
  /**
   * Record a whole message: text (and `reasoning_content`, and the tool-call
   * JSON) by the character estimate, each image part at the flat image charge —
   * an inline image's base64 length would otherwise read as megatokens of text.
   */
  chargeMessage(message: ChannelMessage): void;
  /**
   * Cut text to what still fits and charge what is kept — suffix included, so
   * the marker the caller appends is inside the budget, not on top of it. The
   * caller owns every wording; this owns only the arithmetic.
   */
  fitText(text: string, options?: FitOptions): FittedText;
  /** True once any {@link fitText} call had to cut. */
  truncated(): boolean;
}

class Budget implements RunContextBudget {
  /** May go negative: debt from post-exhaustion protocol strings is tracked. */
  private left: number;
  private didTruncate = false;

  constructor(capacityTokens: number) {
    this.left = Math.max(0, capacityTokens);
  }

  snapshot() { return { left: this.left, truncated: this.didTruncate }; }

  static restore(state: { left: number; truncated: boolean }): Budget {
    const budget = new Budget(0);
    budget.left = state.left;
    budget.didTruncate = state.truncated;
    return budget;
  }

  remaining(): number {
    return Math.max(0, this.left);
  }

  private charge(tokens: number): void {
    this.left -= tokens;
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

  fitText(text: string, options?: FitOptions): FittedText {
    const total = estimateContextTokens(text);
    if (total <= this.left) {
      this.charge(total);
      return { text, truncated: false, kept: true };
    }
    this.didTruncate = true;
    const suffix = options?.suffix ?? "";
    const room = this.left - estimateContextTokens(suffix);
    if (room <= 0) {
      return { text: "", truncated: true, kept: false };
    }
    // Cut proportionally, then walk down: a prefix denser in wide characters
    // than the whole can still overshoot, so the first guess is corrected
    // rather than trusted. Each step drops 10%, so this terminates fast.
    let keep = Math.floor(text.length * (room / total));
    let cut = cutCodePoints(text, keep);
    while (keep > 0 && estimateContextTokens(cut) > room) {
      keep = Math.floor(keep * 0.9);
      cut = cutCodePoints(text, keep);
    }
    if (cut.length < (options?.minKeepChars ?? 1)) {
      return { text: "", truncated: true, kept: false };
    }
    this.charge(estimateContextTokens(cut) + estimateContextTokens(suffix));
    return { text: cut + suffix, truncated: true, kept: true };
  }

  truncated(): boolean {
    return this.didTruncate;
  }
}

export function restoreRunContextBudget(state: { left: number; truncated: boolean }): RunContextBudget {
  return Budget.restore(state);
}

/**
 * How much input one model can hold: its own window, less what it may generate
 * into that window.
 *
 * The Agent's `maxTokens` bounds both models' calls on the wire, so when it is
 * set it is the reserve for each. When it is not, no `max_tokens` is sent and
 * whichever model serves the call may generate up to its own registry maximum —
 * which is that model's number, and comes out of that model's window.
 */
function inputCapacity(config: ModelConfig, maxOutputTokens: number | undefined): number {
  return config.contextWindow - (maxOutputTokens ?? config.maxTokens);
}

/**
 * Return a budget for registered model capacity minus protocol headroom.
 * Each model reserves its own output cap before fallback capacities are
 * compared. Missing facts or non-positive capacity leave no derived budget.
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
  const capacity = Math.min(
    inputCapacity(primary, maxOutputTokens),
    fallback ? inputCapacity(fallback, maxOutputTokens) : Number.POSITIVE_INFINITY,
  );
  if (capacity - PROTOCOL_HEADROOM_TOKENS <= 0) {
    // A `maxTokens` at or above the model's window leaves no capacity to
    // derive: a zero budget would answer every tool call "budget exhausted"
    // from turn 0 and blame a budget the run never got to fill. Nothing
    // meaningful can be enforced from an impossible configuration, so the run
    // stays unbudgeted — the provider is the one that rejects it coherently.
    return undefined;
  }
  return new Budget(capacity - PROTOCOL_HEADROOM_TOKENS);
}
