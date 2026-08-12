import type { Version } from "@/domain/project/types";

/**
 * The version's system prompt is its persistent style. An image provider has
 * no system message, so the style rides in front of every subject prompt —
 * the caller's, the rendered template's, or a transfer's message — and the
 * subject stays the caller's to supply. The agent builtins are the deliberate
 * exception: an agent's system prompt is its behaviour, not a picture style.
 *
 * Lives apart from `generateImage` because importing that module is starting
 * an image run (`IMAGE_RUN_ENTRY_POINTS` in the architecture test), and the
 * image-subagent path composes a prompt without starting one.
 */
export function composeImagePrompt(version: Version, subject: string): string {
  return [version.systemPrompt.trim(), subject].filter(Boolean).join("\n\n");
}
