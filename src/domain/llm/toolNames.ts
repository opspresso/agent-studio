export const SKILL_TOOL_NAME = "Skill";
/** Stable SDK function names, including projects whose names reach the 64-character cap. */
export function agentToolName(name: string, mode: "handoff" | "delegate" | "external"): string {
  const prefix = mode === "handoff" ? "handoff_" : "delegate_";
  const full = prefix + name;
  if (full.length <= 64) return full;
  let hash = 2166136261;
  for (const character of name) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `${full.slice(0, 55)}_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
/** The visible target encoded in a native agent tool's public name. */
export function agentToolTarget(name: string): string | undefined {
  return /^(?:handoff|delegate)_(.+)$/.exec(name)?.[1];
}
export const IMAGE_TOOL_NAME = "GenerateImage";
export const EDIT_IMAGE_TOOL_NAME = "EditImage";
export const FETCH_URL_TOOL_NAME = "FetchUrl";
export const FILE_TOOL_NAME = "File";
export const WORKSPACE_TOOL_NAME = "Workspace";
export const IMPORT_FILE_TOOL_NAME = "ImportFile";
export const TRANSCRIBE_AUDIO_TOOL_NAME = "TranscribeAudio";
export const AUDIO_JOB_TOOL_NAME = "AudioJob";
export const AUDIO_TOOL_NAMES: readonly string[] = [IMPORT_FILE_TOOL_NAME, TRANSCRIBE_AUDIO_TOOL_NAME, AUDIO_JOB_TOOL_NAME];
export const SAVE_FILE_TOOL_NAME = "SaveFile";
export const SLACK_HISTORY_TOOL_NAME = "SlackHistory";
export const SLACK_THREAD_TOOL_NAME = "SlackThread";
export const SLACK_USER_TOOL_NAME = "SlackUser";
export const SLACK_USERS_TOOL_NAME = "SlackUsers";
export const SLACK_CHANNELS_TOOL_NAME = "SlackChannels";
export const SLACK_REACTIONS_TOOL_NAME = "SlackReactions";
/** The set served by one reader, so the loop can route them together. */
export const SLACK_TOOL_NAMES: readonly string[] = [
  SLACK_HISTORY_TOOL_NAME,
  SLACK_THREAD_TOOL_NAME,
  SLACK_USER_TOOL_NAME,
  SLACK_USERS_TOOL_NAME,
  SLACK_CHANNELS_TOOL_NAME,
  SLACK_REACTIONS_TOOL_NAME,
];
/**
 * Every name a builtin may claim. An MCP tool that arrives under one of these
 * must be aliased even when that builtin is inactive for the run: whether a
 * builtin is offered depends on the version, while the alias must be stable and
 * decided before the run's tool set is built.
 */
export const BUILTIN_TOOL_NAMES: readonly string[] = [
  SKILL_TOOL_NAME,
  IMAGE_TOOL_NAME,
  EDIT_IMAGE_TOOL_NAME,
  FETCH_URL_TOOL_NAME,
  SAVE_FILE_TOOL_NAME,
  FILE_TOOL_NAME,
  WORKSPACE_TOOL_NAME,
  ...AUDIO_TOOL_NAMES,
  ...SLACK_TOOL_NAMES,
];
