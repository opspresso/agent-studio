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
 * - Everything else: 1.5 tokens per char — above what modern tokenizers charge
 *   for Hangul/CJK (~0.7–1.5), below the worst legacy case (~2–3). The worst
 *   case was tried first and rejected by what it did to legitimate input: a
 *   chat replaying 67,000 Korean characters (well inside a 200k window) was
 *   estimated over the whole budget, and every tool call of a run that used
 *   to work answered "budget exhausted" from turn 0.
 * - An image part: a flat {@link IMAGE_PART_TOKENS}, because its `data:` URL's
 *   base64 length says nothing about what the provider charges for the image.
 *
 * Both classes round *against* the run on purpose: an overestimate truncates
 * tool output a little early and says so; an underestimate is a provider 400
 * that kills the run mid-stream. Everything inserted is charged — truncation
 * markers are reserved *inside* a fit, wrappers and omission strings are
 * charged where they are appended — so {@link PROTOCOL_HEADROOM_TOKENS}
 * covers only what no string measurement can see: message framing, tool-call
 * envelopes, provider protocol overhead.
 *
 * A model absent from the registry gets **no budget** (`undefined`): there is
 * no window to derive one from, and inventing a number would truncate runs
 * against a limit nobody configured. When a `fallbackModel` is configured the
 * budget is the **minimum of the two capacities**, each taken from its own
 * window — see {@link createRunContextBudget} for why "each from its own" is the
 * part that has to be said.
 */

import { getModelConfig, type ModelConfig } from "@/domain/llm/models";
import type { ChannelMessage } from "@/domain/llm/channel";
import { cutCodePoints } from "@/shared/utf8Text";

const ASCII_CHARS_PER_TOKEN = 3;
/** Applied as ×3/2 so the arithmetic stays in integers. */
const NON_ASCII_TOKENS_PER_2_CHARS = 3;
/**
 * Flat token charge for one image content part, whatever its byte size. At the
 * top of the published provider range (OpenAI high-detail ~2,500; Anthropic
 * ~1,600), rounding against the run so screenshot-heavy context cannot claim
 * headroom up to a provider 400.
 */
export const IMAGE_PART_TOKENS = 2_500;
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
 * The version's `maxTokens` bounds both models' calls on the wire, so when it is
 * set it is the reserve for each. When it is not, no `max_tokens` is sent and
 * whichever model serves the call may generate up to its own registry maximum —
 * which is that model's number, and comes out of that model's window.
 */
function inputCapacity(config: ModelConfig, maxOutputTokens: number | undefined): number {
  return config.contextWindow - (maxOutputTokens ?? config.maxTokens);
}

/**
 * The budget for one run, or `undefined` when the model is not in the registry
 * (no window to derive from — such a run stays unbudgeted, exactly as every
 * run was before the budget existed).
 *
 * With a fallback configured the budget is the **smaller of the two capacities**,
 * because a mid-run switch must still fit what the other model had already
 * accumulated. Each capacity subtracts that model's own output cap from its own
 * window; mixing the minimum window with the maximum cap can reduce a valid
 * context to a small fraction of either model's capacity.
 *
 * The invariant it enforces is per model and always was: whichever one serves a
 * call, what has accumulated plus what that model may generate has to fit inside
 * that model's window. That is the whole reason, and it is worth resisting a
 * shorter one: "a bigger output cap comes with a bigger window" sounds like it
 * explains the same thing and is **false here** — `bedrock/minimax-m2.5` may
 * generate 196,608 tokens into a 204,800-token window while
 * `openrouter/nemotron-3-super-120b` generates 16,384 into 1,000,000. Only the
 * capacities can be compared, which is what this does.
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
