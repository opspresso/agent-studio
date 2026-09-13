/** Per-turn text accounting over the model context budget. */

import type { RunContextBudget } from "./contextBudget";
import { cutCodePoints } from "@/shared/utf8Text";

/**
 * Tool-result text one turn may add to the context. Each result is already
 * capped on its own, but a turn holding several of them plus a whole skill body
 * would blow the context window (or the bill) before the provider complains.
 */
export const MAX_TOOL_RESULT_CHARS_PER_TURN = 200_000;

/**
 * Below this, a run-budget-truncated result reads as data while carrying none
 * of it — the same judgement `MIN_TRANSFER_LINE_CHARS` makes for a transcript
 * line — so the result is omitted with a reason instead.
 */
export const MIN_KEPT_RESULT_CHARS = 500;

/**
 * Spend one turn's tool-result budget in call order. Truncation is explicit so
 * the model can narrow its next call instead of silently working from a cut-off
 * payload; an entirely omitted result is reported as an error, which also makes
 * budget exhaustion visible as a failed span in the trace.
 *
 * The run-level context budget sits underneath: what survives the per-turn cap
 * must still fit what the whole run may accumulate, so a small-window model
 * truncates below the per-turn cap instead of overflowing into a provider 400.
 */
export interface ToolResultBudget {
  /**
   * Fit a result whose length the engine does not control — tool output, a
   * child's answer, a provider's error body — cutting and marking it as needed.
   */
  fit(content: string): string;
  /** Characters available for results, persisted across approval checkpoints. */
  remaining(): number;
  /**
   * Charge a refusal the engine wrote itself and hand it back unchanged.
   *
   * These are bounded by construction, and their exact wording is the whole
   * point: replacing "max_turn reached before transfer" with "this turn's tool
   * output budget is exhausted" trades the reason for the accounting, on a
   * string too short for the accounting to care about. They still enter the
   * context, so they still pay — which is what makes "everything inserted is
   * charged" true rather than nearly true.
   */
  charge(content: string): string;
}

/**
 * The marker `fit` appends when the per-turn budget cut a result. Shared with
 * the dispatch assembly, which reserves room for it when sizing each task's
 * share — the marker lands *on top of* what `fit` kept, so a share sized
 * without it built a group larger than the budget the shares were carved from.
 */
export function turnTruncationMarker(kept: number, of: number): string {
  return `\n…(truncated: kept ${kept} of ${of} chars, this turn's tool output budget is exhausted)`;
}

export function createToolResultBudget(
  total: number,
  runBudget?: RunContextBudget,
): ToolResultBudget {
  let remaining = total;
  const charge = (content: string): string => {
    runBudget?.chargeText(content);
    remaining -= content.length;
    return content;
  };
  const fit = (content: string): string => {
    // The floor the run-budget path already enforces, applied to the per-turn
    // cut too: a 12-character fragment wearing a "kept 12 of 48231 chars"
    // marker reads like data and carries none — the omission note says more.
    const cutBelowFloor = content.length > remaining && remaining < MIN_KEPT_RESULT_CHARS;
    if (remaining <= 0 || cutBelowFloor) {
      // The tool protocol forces a result message per call, so this string
      // enters the context regardless — charged, so the budget stays honest
      // about it instead of the gap widening silently.
      const omitted =
        "Error: tool result omitted — this turn's tool output budget is exhausted. Request less data, or call one tool at a time.";
      runBudget?.chargeText(omitted);
      remaining -= omitted.length;
      return omitted;
    }
    // Never through a surrogate pair: half a character does not survive
    // persistence or the wire, and the run-budget fit below backs off the
    // same way.
    const turnCut = content.length > remaining ? cutCodePoints(content, remaining) : content;
    if (runBudget) {
      // The bare cut text goes through the fit; the marker is chosen *after*
      // both budgets have spoken, by whichever constraint actually bound —
      // a per-turn "kept N of M chars" claim re-cut by the run budget would
      // assert a length the final text no longer has.
      const fitted = runBudget.fitText(turnCut, {
        suffix: "\n…(truncated: the run's context budget is exhausted)",
        minKeepChars: MIN_KEPT_RESULT_CHARS,
      });
      if (!fitted.kept) {
        const omitted =
          "Error: tool result omitted — the run's context budget is exhausted. Answer from what you already have.";
        runBudget.chargeText(omitted);
        remaining -= omitted.length;
        return omitted;
      }
      if (fitted.truncated) {
        // The turn is debited what actually entered the context, not what the
        // per-turn cut would have kept — a later call this turn must not be
        // starved against text the context never received.
        remaining -= fitted.text.length;
        return fitted.text;
      }
    }
    let text = turnCut;
    if (turnCut.length < content.length) {
      const marker = turnTruncationMarker(turnCut.length, content.length);
      // Appended on top of a fit that did not cut, so it is charged where it
      // is appended — everything inserted is charged.
      runBudget?.chargeText(marker);
      text += marker;
    }
    remaining -= text.length;
    return text;
  };
  return { fit, charge, remaining: () => Math.max(0, remaining) };
}
