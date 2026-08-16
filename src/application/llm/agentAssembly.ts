/**
 * What an agent run is told it can do — the prompt sections, the tool
 * definitions, and the one assembly (`assembleAgentRun`) both the tool loop and
 * the Playground preview go through.
 *
 * Split from `engine.ts` as one of its two internal modules (the other is
 * `toolResultBudget.ts`): everything here is pure derivation over the run's
 * capabilities, shared with the preview, and none of it touches loop state.
 * The engine re-exports the public surface, so callers keep one import path.
 */

import type { ChannelToolDef } from "@/domain/llm/channel";
import type { ChatMessageInput, EngineChunk } from "@/domain/llm/types";
import { parseImageDataUrl } from "@/domain/llm/types";
import type { RunCaller } from "@/domain/execution/actor";
import { formatRunClock } from "@/shared/date";

export const SKILL_TOOL_NAME = "Skill";
export const TRANSFER_TOOL_NAME = "transfer_to_agent";
export const DISPATCH_TOOL_NAME = "dispatch_agents";
export const IMAGE_TOOL_NAME = "GenerateImage";
export const EDIT_IMAGE_TOOL_NAME = "EditImage";
export const FETCH_URL_TOOL_NAME = "FetchUrl";
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
  TRANSFER_TOOL_NAME,
  DISPATCH_TOOL_NAME,
  IMAGE_TOOL_NAME,
  EDIT_IMAGE_TOOL_NAME,
  FETCH_URL_TOOL_NAME,
  ...SLACK_TOOL_NAMES,
];

/**
 * Agents one `dispatch_agents` call may run at once.
 *
 * Lower than the MCP ceiling on purpose: a child is a whole run — its own tool
 * resolution, MCP sessions and multi-turn loop — not one request. And it is a
 * hard bound rather than a queue because a subagent run does not pass through
 * the run bracket, so these children are outside the concurrency and cost
 * guards; the only thing limiting them is this number and the fact that a child
 * is never offered this tool.
 */
export const MAX_DISPATCH_TASKS = 4;

/** An image this run can edit, addressed by a short id the model can quote. */
export interface ImageHandle {
  id: string;
  b64: string;
  mimeType: string;
  origin: string;
}

/**
 * The images EditImage can reach in one run: the user's inline attachments plus
 * everything the run has drawn so far. Ids are stable for the run and travel to
 * the model through the system prompt and the image tool results.
 */
export class ImageRegistry {
  private readonly handles: ImageHandle[] = [];

  add(image: { b64: string; mimeType: string }, origin: string): ImageHandle {
    const handle: ImageHandle = { id: `img_${this.handles.length + 1}`, ...image, origin };
    this.handles.push(handle);
    return handle;
  }

  get(id: string): ImageHandle | undefined {
    return this.handles.find((handle) => handle.id === id);
  }

  list(): readonly ImageHandle[] {
    return this.handles;
  }
}

/**
 * Register every inline image in the input messages. An https image part is
 * skipped: the provider fetches those itself, so the bytes an edit needs are
 * not in hand.
 */
function registerInputImages(registry: ImageRegistry, messages: ChatMessageInput[]): void {
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      if (part.type !== "image_url") {
        continue;
      }
      const bytes = parseImageDataUrl(part.image_url.url);
      if (bytes) {
        registry.add(bytes, message.role === "assistant" ? "an earlier answer" : "sent by the user");
      }
    }
  }
}

export interface SkillInfo {
  name: string;
  description: string;
}

export interface SubagentInfo {
  name: string;
  description: string;
  type: "local" | "remote";
}

/** Connected MCP server overview; tool names are the aliased names the model sees. */
export interface McpServerInfo {
  name: string;
  description: string;
  toolNames: string[];
}

/** Load full skill content for progressive disclosure. */
export type SkillContentLoader = (skillName: string, filePath?: string) => Promise<string>;

/**
 * Run a subagent transfer. Yields the child's (already authored) stream
 * chunks and returns the child's final text for the "For context" message.
 */
export type SubagentRunner = (
  agentName: string,
  message: string,
  turn: number,
  maxTurn: number,
  /** Images the parent handed over; the child edits or looks at them. */
  images?: Array<{ b64: string; mimeType: string }>,
  /**
   * The conversation the child was not part of, already rendered and budgeted
   * (see `buildTransferTranscript`). Passed separately from `message` because
   * only the runner knows the child's type: an image child's message *is* its
   * image prompt, so a transcript must never be folded into it.
   */
  transcript?: string,
) => AsyncGenerator<EngineChunk, string>;

/** Generate an image for the builtin GenerateImage tool. */
export type ImageGenerator = (
  prompt: string,
  size?: string,
  quality?: string,
) => Promise<{ b64: string; mimeType: string }>;

/**
 * Edit existing image bytes for the builtin EditImage tool. The engine owns the
 * handle bookkeeping and hands over the resolved bytes, so this stays pure I/O.
 */
export type ImageEditor = (params: {
  prompt: string;
  images: Array<{ b64: string; mimeType: string }>;
  size?: string;
  quality?: string;
}) => Promise<{ b64: string; mimeType: string }>;

/**
 * Read a URL the model named.
 *
 * One tool rather than the `fetch_image`/`fetch_document` pair the MCP server
 * split it into. That split existed because a server has to decide before
 * fetching what `Accept` to send and which block type to answer with; inside the
 * app it does not, and the cost of it was real — the model had to guess the
 * target's type, and a wrong guess burned a turn. The sibling server grew a
 * `crossToolHint` to patch exactly that.
 */
export type UrlFetcher = (url: string) => Promise<{
  text: string;
  note?: string;
  image?: { b64: string; mimeType: string };
}>;

/**
 * The capability half of the engine's deps — the injected abilities whose
 * *presence* decides what a run is told it can do. Declared here, structurally,
 * rather than as a `Pick` of `AgentDeps`: the assembly is what the loop and the
 * preview share, so it must not import the loop. `AgentDeps` extends this, and
 * anything satisfying it by shape previews exactly what it would run.
 */
export interface AgentCapabilityDeps {
  loadSkillContent?: SkillContentLoader;
  runSubagent?: SubagentRunner;
  generateImage?: ImageGenerator;
  editImage?: ImageEditor;
  fetchUrl?: UrlFetcher;
  /**
   * Serves the Slack read tools, or absent when this run has no workspace
   * to look at. One function rather than four deps: the tools differ only in
   * which Slack call they make, and the reader already holds the token that
   * decides *which* workspace — a choice the model must not get to make.
   */
  readSlack?: (tool: string, args: Record<string, unknown>) => Promise<string>;
}

/**
 * `a`, `a and b`, `a, b, and c`. Used to build the sentences below from the
 * capabilities a run actually resolved, so neither the routing rule nor the
 * image empty state ever names something this run cannot reach.
 */
function joinClauses(items: string[], conjunction: string): string {
  if (items.length <= 1) {
    return items[0] ?? "";
  }
  const last = items[items.length - 1] ?? "";
  const head = items.slice(0, -1);
  return items.length === 2
    ? `${head[0] ?? ""} ${conjunction} ${last}`
    : `${head.join(", ")}, ${conjunction} ${last}`;
}

/**
 * The boundary between the version's own prompt and what the engine appends.
 *
 * The sections below are generated per run and use `##` headings, which are
 * indistinguishable from headings the prompt author wrote — so the split is
 * marked explicitly. It also gives the routing rule a referent: "your
 * instructions" is everything above this line, and nothing else.
 */
function capabilityFraming(
  withSkills: boolean,
  withMcp: boolean,
  withSubagents: boolean,
): string {
  // Stated once, here. Each section below documents only what is specific to
  // it; three sections that each also said "use me when…" would leave the model
  // with unranked policies and no way to choose between them.
  const rules = [
    ...(withSkills ? ["load a skill when you need guidance on how to carry it out"] : []),
    ...(withMcp
      ? ["call a tool when you need data or an action from outside this conversation"]
      : []),
    ...(withSubagents
      ? ["transfer to an agent whose description covers the request better than your instructions do"]
      : []),
  ];
  const lines = [
    "# Runtime capabilities",
    "",
    "The instructions above define your role. This section is generated for this run and lists only what you can actually reach right now — treat it, not your instructions, as the truth about what is available.",
  ];
  if (rules.length > 0) {
    lines.push(
      "",
      `Your instructions define your role and constraints. Within that role, ${joinClauses(rules, "or")}.`,
    );
  }
  return lines.join("\n");
}

function skillSystemPromptAddition(skills: SkillInfo[]): string {
  const rows = skills
    .map((s) => `| ${s.name} | ${tableCell(s.description) || "No description"} |`)
    .join("\n");
  // No usage line: when to load one is the framing's job and which one to load
  // is the description's, while reaching a file inside a skill is documented on
  // the tool's own `file_path` parameter, which the model reads anyway.
  return [
    "## Available Skills",
    "",
    "| Skill | Description |",
    "|-------|-------------|",
    rows,
  ].join("\n");
}

/** One markdown table cell: a newline or a pipe in the value would break the row. */
function tableCell(value: string): string {
  return value.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim();
}

function mcpSystemPromptAddition(servers: McpServerInfo[]): string {
  const rows = servers
    .map((s) => `| ${s.name} | ${tableCell(s.description)} | ${s.toolNames.join(", ")} |`)
    .join("\n");
  // Says what the table *is*; when to reach for it is the framing's job.
  return [
    "## Connected MCP Servers",
    "",
    "These tools come from external MCP servers.",
    "",
    "| Server | Description | Tools |",
    "|--------|-------------|-------|",
    rows,
  ].join("\n");
}

/**
 * Shaped like the skill and MCP sections: same heading level, same table, same
 * `tableCell` escaping, so a description that spans lines or carries a pipe
 * cannot end the section early and swallow the agents listed after it.
 *
 * The set of names is not restated in prose: `transfer_to_agent`'s `agent_name`
 * is an enum, which constrains the call itself rather than asking for it.
 */
function subagentSystemPromptAddition(subagents: SubagentInfo[], withDispatch: boolean): string {
  const rows = subagents
    .map(
      (a) =>
        `| ${a.name} | ${a.type} | ${tableCell(a.description) || "No description"} |`,
    )
    .join("\n");
  // Only the constraints the framing cannot state. "Background" is deliberate
  // and not "context you can rely on": the conversation rides along for an
  // agent or prompt child, but an image child is handed the `message` alone
  // (it is that child's image prompt), and the engine cannot tell them apart
  // from here — so the request itself always has to be complete.
  const lines = [
    "## Available Agents",
    "",
    "`message` is the whole of the request: the other agent does not see your instructions, so say what it should do. Recent conversation may be passed as background depending on the agent type, but `message` must always be self-contained. Once it has answered, do not transfer to it again for the same request.",
  ];
  if (withDispatch) {
    // Which of the two tools fits is specific to this section, like everything
    // else stated here — it is a fact about these agents, not a routing rule,
    // so it does not belong in the framing.
    lines.push(
      "",
      `Parts that do not depend on each other go to \`${DISPATCH_TOOL_NAME}\` in **one** call, so they run at the same time. A single request goes to \`${TRANSFER_TOOL_NAME}\`.`,
    );
  }
  lines.push("", "| Agent | Type | Description |", "|-------|------|-------------|", rows);
  return lines.join("\n");
}

function skillToolDef(skills: SkillInfo[]): ChannelToolDef {
  return {
    type: "function",
    function: {
      name: SKILL_TOOL_NAME,
      description:
        "Load the content of a connected skill. Returns the skill's main content (SKILL.md) or a specific file within the skill.",
      parameters: {
        type: "object",
        properties: {
          skill_name: {
            type: "string",
            // Enumerated like the transfer tool's `agent_name`: a free-text name
            // is the main source of "skill is not connected" round trips.
            enum: skills.map((s) => s.name),
            description: "The name of the skill to load.",
          },
          file_path: {
            type: "string",
            description:
              "Optional. Path to a specific file within the skill (e.g., 'references/REFERENCE.md').",
          },
        },
        required: ["skill_name"],
      },
    },
  };
}

function transferToolDef(subagents: SubagentInfo[], withImages: boolean): ChannelToolDef {
  return {
    type: "function",
    function: {
      name: TRANSFER_TOOL_NAME,
      description: "Transfer a specific message to another connected agent.",
      parameters: {
        type: "object",
        properties: {
          agent_name: {
            type: "string",
            enum: subagents.map((a) => a.name),
            description: "The agent name to transfer to.",
          },
          message: {
            type: "string",
            description: "The full message to send to the target agent.",
          },
          ...(withImages
            ? {
                image_ids: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Ids of images to hand over (see Available Images). Pass these when a local agent must edit or look at an existing image instead of making one up. Remote agents cannot receive images.",
                },
              }
            : {}),
        },
        required: ["agent_name", "message"],
      },
    },
  };
}

/**
 * Fan-out, where {@link transferToolDef} is handoff.
 *
 * Two tools rather than one widened tool. A call that runs several agents is a
 * different shape from one that hands the request to a single agent: the array
 * is what lets the model say "these do not depend on each other", and because it
 * is one call, the whole group keeps its place in call order and its answers
 * land in one tool result — spent from the same turn budget as every other tool
 * result rather than appended to the context with no budget at all.
 */
function dispatchToolDef(subagents: SubagentInfo[], withImages: boolean): ChannelToolDef {
  return {
    type: "function",
    function: {
      name: DISPATCH_TOOL_NAME,
      description: `Run several connected agents at the same time and collect their answers. Use this instead of ${TRANSFER_TOOL_NAME} when the request splits into parts that do not depend on each other. At most ${MAX_DISPATCH_TASKS} agents per call.`,
      parameters: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            minItems: 1,
            maxItems: MAX_DISPATCH_TASKS,
            description:
              "One entry per agent. They run concurrently, so no entry may depend on another's answer — dependent work belongs in a later turn.",
            items: {
              type: "object",
              properties: {
                agent_name: {
                  type: "string",
                  enum: subagents.map((a) => a.name),
                  description: "The agent to run.",
                },
                message: {
                  type: "string",
                  description:
                    "The full message for this agent. It sees neither your instructions nor the other tasks.",
                },
                ...(withImages
                  ? {
                      image_ids: {
                        type: "array",
                        items: { type: "string" },
                        description:
                          "Ids of images to hand to this local agent (see Available Images). Remote agents cannot receive images.",
                      },
                    }
                  : {}),
              },
              required: ["agent_name", "message"],
            },
          },
        },
        required: ["tasks"],
      },
    },
  };
}

function imageSystemPromptAddition(
  handles: readonly ImageHandle[],
  uses: { canEdit: boolean; canTransfer: boolean },
  withMcpTools: boolean,
): string {
  // Listed even when empty: the image tools' only documentation is a pointer to
  // this section, so it has to exist before the first picture does. The empty
  // state names only the routes an id can actually arrive by — the image tools
  // are offered together, so a run that cannot edit cannot generate either, and
  // a run with no MCP tools has nothing that could return a picture. Promising
  // an id from a source this run does not have is the same defect as listing a
  // skill that can never load.
  const arrivals = [
    ...(uses.canEdit ? ["from what you generate or edit"] : []),
    ...(withMcpTools ? ["from what a tool returns"] : []),
    "from what the user sends",
  ];
  const emptyState = `No images yet. Ids appear here as images arrive — ${joinClauses(arrivals, "and")}.`;
  const table =
    handles.length > 0
      ? [
          "| Image | Source |",
          "|-------|--------|",
          ...handles.map((h) => `| ${h.id} | ${tableCell(h.origin)} |`),
        ]
      : [emptyState];
  const howTo: string[] = [];
  if (uses.canEdit) {
    howTo.push(
      `Pass an id to the \`${EDIT_IMAGE_TOOL_NAME}\` tool to change that image. An image you generate later also gets an id, reported in the ${IMAGE_TOOL_NAME} result.`,
    );
  }
  if (uses.canTransfer) {
    howTo.push(
      `Pass ids as \`image_ids\` on \`${TRANSFER_TOOL_NAME}\`, or on each \`${DISPATCH_TOOL_NAME}\` task, so a local agent receives the actual picture instead of a description of it. Remote agents cannot receive images.`,
    );
  }
  return ["## Available Images", "", ...howTo.flatMap((line) => [line, ""]), ...table].join("\n");
}

/**
 * The version's own text, then everything the engine appends, behind one `---`.
 *
 * Single owner of that boundary. Both prompt assemblies — the agent's and the
 * single-shot one — append to an author's text, and a second copy of the rule
 * would drift the moment one of them grew a block the other did not have.
 *
 * A thematic break, not a heading: it separates without competing with the
 * author's own headings, and the blank line `join` adds keeps it from being read
 * as a setext underline for the line above. No blocks returns the author's text
 * byte-for-byte — a boundary is never announced with nothing behind it.
 */
export function withEngineBlocks(base: string | undefined, blocks: string[]): string {
  if (blocks.length === 0) {
    return base ?? "";
  }
  const parts: string[] = [];
  if (base) {
    parts.push(base, "---");
  }
  parts.push(...blocks);
  return parts.join("\n\n");
}

/**
 * Stated as a fact, not as a `##` section: it is one line, and a heading would
 * compete with the capability sections while carrying a fraction of their
 * content. The instruction is what makes it useful — a model that is told the
 * date still answers "last week" from its training data unless it is told to
 * resolve relative dates from this line.
 */
export function runClockBlock(now: Date): string {
  return `Current date and time: ${formatRunClock(now)}. Resolve anything relative — "today", "yesterday", "last week", "this quarter" — from this line rather than from what you remember.`;
}

/**
 * Who this run is answering, when the surface knows and the version asked for it.
 *
 * A fact about the run in the same sense the clock is: the model is told, it
 * cannot go looking. Without it a Slack thread reaches the model as anonymous
 * text and the answer cannot address anybody — which is what a conversational
 * agent is for.
 *
 * The avatar is a URL rather than an image part: a face is almost never what the
 * question is about, and encoding one would spend a turn's image budget on it.
 *
 * But a URL nobody said was reachable is a URL nobody reaches. Asked to redraw
 * their own profile picture, a run with every capability switched on invented a
 * face instead — the address was sitting in this block, `FetchUrl` was offered
 * and returns an image as an editable handle, and nothing connected the two.
 * `FetchUrl`'s own description names requests, search results and tool output as
 * where an address turns up, which is every place except this one; and
 * `EditImage` points at the handle list, which the avatar is not in. So the
 * block says it, and only where the run can actually act on it — advice a run
 * cannot take is worse than none.
 */
export function callerBlock(caller: RunCaller, canFetchUrl = false): string {
  const lines = [`You are answering ${caller.displayName}.`];
  if (caller.timezone) {
    lines.push(`Their timezone is ${caller.timezone}; resolve their relative times in it.`);
  }
  if (caller.avatarUrl) {
    lines.push(
      canFetchUrl
        ? `Their avatar: ${caller.avatarUrl} — when the request is about their picture, read it with ${FETCH_URL_TOOL_NAME} first; it comes back as an image you can then edit. Never draw a face from imagination in its place.`
        : `Their avatar: ${caller.avatarUrl}`,
    );
  }
  return lines.join(" ");
}

export interface AgentSystemPromptInput {
  /** The version's own system prompt; the engine's blocks are appended to it. */
  base?: string;
  skills: SkillInfo[];
  subagents: SubagentInfo[];
  mcpServers: McpServerInfo[];
  images: { handles: readonly ImageHandle[]; canEdit: boolean; canTransfer: boolean };
  /** The run's wall clock, injected. Omitted keeps the prompt clock-free. */
  now?: Date;
  /** Whether this run is offered `dispatch_agents` (see {@link buildAgentTools}). */
  canDispatch?: boolean;
  /** Whether this run may read a URL — another way a picture can arrive. */
  withUrlTool?: boolean;
  /** Who is asking. Omitted keeps the prompt anonymous. */
  caller?: RunCaller;
}

/**
 * The system prompt an agent run actually sends: the version's own text, then a
 * marked block of the sections the engine appends for what this run can reach.
 * Exported for the Playground preview — the assembled prompt is what a reader
 * needs to see, and a second implementation of it would drift.
 *
 * A run that reaches nothing gets the version's text unchanged: framing an
 * empty capability block would announce a boundary with nothing behind it.
 */
export function buildAgentSystemPrompt(input: AgentSystemPromptInput): string {
  const { base, skills, subagents, mcpServers, images, now, caller } = input;
  const canDispatch = input.canDispatch ?? false;
  const withMcp = mcpServers.length > 0;
  // Either can hand back a picture, and the empty state below names the routes
  // an id can actually arrive by. Naming a route this run does not have is the
  // same defect as listing a skill that can never load — and so is omitting one
  // it does.
  const toolsCanReturnImages = withMcp || input.withUrlTool === true;
  const sections: string[] = [];
  if (skills.length > 0) {
    sections.push(skillSystemPromptAddition(skills));
  }
  if (withMcp) {
    sections.push(mcpSystemPromptAddition(mcpServers));
  }
  if (subagents.length > 0) {
    sections.push(subagentSystemPromptAddition(subagents, canDispatch));
  }
  if (images.canEdit || images.canTransfer) {
    sections.push(imageSystemPromptAddition(images.handles, images, toolsCanReturnImages));
  }
  const blocks: string[] = [];
  // Ahead of the capability block, and outside it: the clock and the caller are
  // facts about when the run happens and who it answers, not things the run can
  // reach, and the framing below speaks only for the sections that follow it.
  if (now) {
    blocks.push(runClockBlock(now));
  }
  if (caller) {
    blocks.push(callerBlock(caller, input.withUrlTool === true));
  }
  if (sections.length > 0) {
    blocks.push(capabilityFraming(skills.length > 0, withMcp, subagents.length > 0), ...sections);
  }
  return withEngineBlocks(base, blocks);
}

const IMAGE_TOOL_DEF: ChannelToolDef = {
  type: "function",
  function: {
    name: IMAGE_TOOL_NAME,
    description:
      "Generate an image from a detailed English prompt. Use when the user asks to draw, create, or generate a picture. The image is delivered to the user automatically — do not describe it as unavailable.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Detailed English image prompt (subject, style, composition, lighting).",
        },
        size: {
          type: "string",
          enum: ["1024x1024", "1536x1024", "1024x1536"],
          description: "Image dimensions; default 1024x1024.",
        },
        quality: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "Rendering quality; default medium.",
        },
      },
      required: ["prompt"],
    },
  },
};

const FETCH_URL_TOOL_DEF: ChannelToolDef = {
  type: "function",
  function: {
    name: FETCH_URL_TOOL_NAME,
    description:
      "Read a web address: a page, a PDF, a plain-text or data file, or an image. " +
      "Returns the text with the markup taken off, or delivers the picture. " +
      "Use it whenever an address appears in a request, a search result or another tool's output and its contents matter — a link is not its contents.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The http(s) address to read.",
        },
      },
      required: ["url"],
    },
  },
};

/**
 * The workspace reads, offered together or not at all.
 *
 * One reader serves all six (`readSlack`), so a run either has a Slack
 * workspace to look at or it does not — there is no partial state to describe,
 * and six independent switches would be six ways to configure the same
 * decision.
 */
const SLACK_TOOL_DEFS: readonly ChannelToolDef[] = [
  {
    type: "function",
    function: {
      name: SLACK_HISTORY_TOOL_NAME,
      description:
        "Read recent messages in a Slack channel, oldest first. Takes the channel *id* — use SlackChannels to turn a #name into one. Use it when the answer depends on what was actually said somewhere, rather than on what the request repeats.",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", description: "The channel id, e.g. C08ABCDEFG." },
          limit: {
            type: "number",
            description: "How many recent messages to read. Defaults to 20, at most 100.",
          },
        },
        required: ["channel"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: SLACK_THREAD_TOOL_NAME,
      description:
        "Read a Slack thread in full, oldest first. Use it when a channel message has replies and the decision is in them — a channel read shows only the message that started the thread.",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", description: "The channel id the thread is in." },
          thread_ts: {
            type: "string",
            description: "The timestamp of the message that started the thread.",
          },
          limit: { type: "number", description: "How many replies to read. Defaults to 20." },
        },
        required: ["channel", "thread_ts"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: SLACK_USER_TOOL_NAME,
      description:
        "Look up who a Slack user id belongs to: name, job title, timezone, status line (where “OOO until Friday” lives), avatar, and whether the account is a bot or deactivated. Email addresses are never returned. Transcripts already name their speakers, so this is for an id that appears somewhere else.",
      parameters: {
        type: "object",
        properties: {
          user: { type: "string", description: "The user id, e.g. U08ABCDEFG." },
        },
        required: ["user"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: SLACK_USERS_TOOL_NAME,
      description:
        "Find people by name or handle, with the same details SlackUser returns. Use it when a request names someone — “what is Ada working on” — and you have a name rather than an id. Deactivated accounts are left out.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Part of a name or handle, e.g. “ada” or “kim”.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: SLACK_CHANNELS_TOOL_NAME,
      description:
        "List the Slack channels this bot can see, with their ids. Use it to turn a #name into the id the other Slack tools take. The listing says whether the bot is a member — it can only read the history of channels it is in.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Only channels whose name contains this. Omit to list them all.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: SLACK_REACTIONS_TOOL_NAME,
      description:
        "Read the emoji reactions on one message, and who left them. Use it when acknowledgement is the question — who has seen a notice, who signed off, whether anyone objected — since a team often answers with a reaction instead of a reply.",
      parameters: {
        type: "object",
        properties: {
          channel: { type: "string", description: "The channel id the message is in." },
          ts: { type: "string", description: "The message's timestamp." },
        },
        required: ["channel", "ts"],
      },
    },
  },
];

const EDIT_IMAGE_TOOL_DEF: ChannelToolDef = {
  type: "function",
  function: {
    name: EDIT_IMAGE_TOOL_NAME,
    description:
      "Edit an existing image: change, add or remove something in it, or restyle it. Address the image by its id (see Available Images, and the ids reported by GenerateImage). The edited image is delivered to the user automatically.",
    parameters: {
      type: "object",
      properties: {
        image_id: {
          type: "string",
          description: "Id of the image to edit, e.g. 'img_1'.",
        },
        prompt: {
          type: "string",
          description:
            "Detailed English instruction describing the edited result, not just the change.",
        },
        size: {
          type: "string",
          enum: ["1024x1024", "1536x1024", "1024x1536"],
          description: "Output dimensions; default 1024x1024.",
        },
        quality: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "Rendering quality; default medium.",
        },
      },
      required: ["image_id", "prompt"],
    },
  },
};

/**
 * The tool set an agent run declares, and the builtin names it claimed.
 * Exported for the Playground preview, which reports the names the model will
 * actually be offered — deriving them a second time would drift from the
 * offered/intercepted contract this function owns.
 */
export interface AgentToolsInput {
  /** MCP tool definitions, already aliased for name collisions. */
  mcpTools?: ChannelToolDef[];
  skills: SkillInfo[];
  subagents: SubagentInfo[];
  /**
   * Whether a skill's content can actually be loaded. Offered on this and not on
   * `skills.length` alone: every other builtin is gated on the dependency that
   * executes it, and the Skill tool was the one that was not — a run that
   * advertised it without a loader answered every call with "cannot be executed
   * in this context", which reads like an MCP fault.
   */
  canLoadSkills: boolean;
  withImageTool: boolean;
  withEditTool: boolean;
  withImageTransfer: boolean;
  /** Whether this run may read an address the model names. */
  withUrlTool: boolean;
  /** Whether this run may read the Slack workspace its project's bot is in. */
  withSlackTools: boolean;
  /**
   * Whether fan-out is offered. False for a subagent run: a child that could
   * dispatch would multiply the run count by depth, and these children run
   * outside the concurrency and cost guards (see {@link MAX_DISPATCH_TASKS}).
   */
  canDispatch?: boolean;
}

export function buildAgentTools(
  input: AgentToolsInput,
): { tools: ChannelToolDef[]; builtinNames: Set<string> } {
  const { mcpTools, skills, subagents, canLoadSkills, withImageTool, withEditTool, withUrlTool } =
    input;
  const withImageTransfer = input.withImageTransfer;
  const canDispatch = input.canDispatch ?? false;
  const tools: ChannelToolDef[] = [...(mcpTools ?? [])];
  // The names of the builtins actually offered. The tool loop intercepts a call
  // only when its name is in here, so "offered" and "intercepted" cannot drift
  // apart — an MCP tool named like an inactive builtin stays reachable.
  const builtinNames = new Set<string>();
  if (canLoadSkills && skills.length > 0) {
    tools.push(skillToolDef(skills));
    builtinNames.add(SKILL_TOOL_NAME);
  }
  if (subagents.length > 0) {
    tools.push(transferToolDef(subagents, withImageTransfer));
    builtinNames.add(TRANSFER_TOOL_NAME);
    if (canDispatch) {
      tools.push(dispatchToolDef(subagents, withImageTransfer));
      builtinNames.add(DISPATCH_TOOL_NAME);
    }
  }
  if (withImageTool) {
    tools.push(IMAGE_TOOL_DEF);
    builtinNames.add(IMAGE_TOOL_NAME);
  }
  if (withEditTool) {
    tools.push(EDIT_IMAGE_TOOL_DEF);
    builtinNames.add(EDIT_IMAGE_TOOL_NAME);
  }
  if (withUrlTool) {
    tools.push(FETCH_URL_TOOL_DEF);
    builtinNames.add(FETCH_URL_TOOL_NAME);
  }
  if (input.withSlackTools) {
    tools.push(...SLACK_TOOL_DEFS);
    for (const name of SLACK_TOOL_NAMES) {
      builtinNames.add(name);
    }
  }
  return { tools, builtinNames };
}

/**
 * What a run can do with an image, which is what decides whether the system
 * prompt carries an `## Available Images` section and whether the image tools
 * are offered. Derived from the deps rather than the version, so the preview
 * and the run cannot disagree about a section's presence.
 */
export function imagePromptUses(
  deps: Pick<AgentCapabilityDeps, "editImage" | "runSubagent">,
  subagents: SubagentInfo[],
): { canEdit: boolean; canTransfer: boolean } {
  return {
    canEdit: Boolean(deps.editImage),
    canTransfer: subagents.some((agent) => agent.type === "local") && Boolean(deps.runSubagent),
  };
}

/** What a run's capabilities decide, assembled once. */
export interface AgentRunAssembly {
  systemPrompt: string;
  tools: ChannelToolDef[];
  /** Builtin names actually offered; the tool loop intercepts exactly these. */
  builtinNames: Set<string>;
  /**
   * The agents this run actually offered — the prompt's table and both transfer
   * tools' enums are built from exactly this list, and so is the check that a
   * requested target was one of them. Returned for the same reason
   * {@link builtinNames} is: what was offered and what is served must come from
   * one value, not from two readings of the input that a dep can make disagree.
   */
  subagents: SubagentInfo[];
  canEdit: boolean;
  canTransfer: boolean;
  /** Images this run can address, seeded from the input messages. */
  images: ImageRegistry;
}

export interface AssembleAgentRunInput {
  /** The version's own system prompt. */
  systemPrompt?: string;
  /** The turn history. Inline images in it are registered when something can act on them. */
  messages?: ChatMessageInput[];
  skills?: SkillInfo[];
  subagents?: SubagentInfo[];
  mcpServers?: McpServerInfo[];
  mcpTools?: ChannelToolDef[];
  now?: Date;
  caller?: RunCaller;
  /** Whether the facade admitted this as a top-level run (see {@link AgentToolsInput}). */
  canDispatch?: boolean;
}

/**
 * Everything a run is assembled with, decided in one place.
 *
 * The two builders below have always had one owner each; what did not was the
 * *argument assembly*. `runAgent` and the Playground preview each spelled out
 * eight and seven positional arguments, and they had already drifted: the
 * preview omitted the eighth, so a version that opted into `callerContext`
 * previewed a prompt without the caller block every real run carries. A field
 * added to either builder is now a type error at both sites rather than a
 * silently-missing positional.
 *
 * Which builtins are offered is derived from the **deps**, never from the
 * version: a capability the run cannot actually perform must not be advertised,
 * and the preview and the run have to agree about that without asking twice.
 */
export function assembleAgentRun(
  deps: AgentCapabilityDeps,
  input: AssembleAgentRunInput,
): AgentRunAssembly {
  const skills = input.skills ?? [];
  // Delegation is described and offered only where it can actually reach a
  // child. Without a runner the transfer tool was still advertised and the
  // prompt still explained it, and a call came back "requires agent_name and
  // message" — a message about the arguments when the reason was that nothing
  // could carry them. Emptying the list here gates the prompt section and both
  // tools at once, which is what keeps them from disagreeing.
  const subagents = deps.runSubagent ? (input.subagents ?? []) : [];
  const { canEdit, canTransfer } = imagePromptUses(deps, subagents);
  // Fan-out additionally needs the facade to have admitted this as a top-level
  // run: a child that could dispatch would multiply the run count by depth.
  const canDispatch = Boolean(input.canDispatch && deps.runSubagent);
  // Handles are worth keeping when something can act on them: this run can edit
  // an image, or it can hand one to another agent that will.
  const images = new ImageRegistry();
  if ((canEdit || canTransfer) && input.messages) {
    registerInputImages(images, input.messages);
  }
  // From the deps, never from the version: a run is told it can do a thing
  // exactly when the thing was injected, so the preview and the run agree.
  const withUrlTool = Boolean(deps.fetchUrl);
  const withSlackTools = Boolean(deps.readSlack);
  const systemPrompt = buildAgentSystemPrompt({
    ...(input.systemPrompt !== undefined ? { base: input.systemPrompt } : {}),
    skills,
    subagents,
    mcpServers: input.mcpServers ?? [],
    images: { handles: images.list(), canEdit, canTransfer },
    ...(input.now ? { now: input.now } : {}),
    canDispatch,
    withUrlTool,
    ...(input.caller ? { caller: input.caller } : {}),
  });
  const { tools, builtinNames } = buildAgentTools({
    ...(input.mcpTools ? { mcpTools: input.mcpTools } : {}),
    skills,
    subagents,
    canLoadSkills: Boolean(deps.loadSkillContent),
    withImageTool: Boolean(deps.generateImage),
    withEditTool: canEdit,
    withImageTransfer: canTransfer,
    withUrlTool,
    withSlackTools,
    canDispatch,
  });
  return { systemPrompt, tools, builtinNames, subagents, canEdit, canTransfer, images };
}
