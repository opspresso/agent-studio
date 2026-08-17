import type { ProjectType } from "@/domain/project/types";
import { projectWebhookPath } from "@/domain/trigger/types";

/**
 * Builds the API Reference tab's endpoint descriptors from a project's public
 * context (name, type, published pointer, integration flags). This module is
 * intentionally pure — it takes **no** secrets, so every rendered example and
 * code sample can only ever contain the placeholder tokens below, never a real
 * session cookie, A2A key, or Slack secret.
 */

export type AuthKind = "token" | "a2a-key" | "trigger-secret" | "slack-signature" | "public";

export const AUTH_LABEL: Record<AuthKind, string> = {
  token: "Bearer token",
  "a2a-key": "X-A2A-Key header",
  "trigger-secret": "X-Trigger-Secret header",
  "slack-signature": "Slack signature",
  public: "Public",
};

/** Placeholder tokens — the only credential-shaped strings any example may contain. */
export const PLACEHOLDERS = {
  token: "$PROJECT_API_TOKEN",
  a2aKey: "$A2A_API_KEY",
  webhookSecret: "$WEBHOOK_SECRET",
  slackSignature: "$SLACK_SIGNATURE",
  slackTimestamp: "$SLACK_TIMESTAMP",
} as const;

/**
 * The optional conversation header the three execution endpoints read, shown
 * on an agent project's examples: that is where a conversation reaches
 * something — an A2A transfer, an MCP server — where a prompt project's run
 * has nothing to continue. The value is the caller's own; the placeholder is
 * not a credential.
 */
const CONVERSATION_HEADER = { "X-Conversation-Id": "$CONVERSATION_ID" } as const;
const CONVERSATION_NOTE =
  " Send the same X-Conversation-Id on the follow-up questions of one conversation: the run then carries it — an A2A subagent it transfers to continues the remote conversation the first question opened, and every MCP server it calls is told which conversation is asking. Optional; without it each request is its own conversation.";

/** A request/response field row. `type` is a display string, not a real TS type. */
export interface FieldSpec {
  name: string;
  type: string;
  required?: boolean;
  description: string;
  children?: FieldSpec[];
}

export type CodeLanguage = "bash" | "python" | "javascript";

export interface CodeExample {
  language: CodeLanguage;
  label: string;
  code: string;
}

export interface ApiEndpoint {
  id: string;
  method: "GET" | "POST";
  path: string;
  title: string;
  description: string;
  auth: AuthKind;
  streaming: boolean;
  requestFields?: FieldSpec[];
  responseFields?: FieldSpec[];
  responseExample?: string;
  errorCodes: number[];
  codeExamples: CodeExample[];
}

export interface ApiReferenceContext {
  projectName: string;
  projectType: ProjectType;
  /** The published version name, or null when the project has no published version. */
  publishedVersion: string | null;
  /** Absolute origin for example URLs (e.g. window.location.origin); "" is tolerated. */
  origin: string;
  /** A2A exposure status, or null when unknown. */
  a2a: { enabled: boolean; published: boolean } | null;
  /**
   * The project webhook's switch, or null when not visible to the viewer — the
   * secret it is authenticated with is owner-readable, so a viewer who cannot
   * see the switch has nothing to call this endpoint with.
   */
  webhook: { enabled: boolean } | null;
  /** Slack integration status (owner or admin), or null when not visible to the viewer. */
  slack: { configured: boolean } | null;
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function curlExample(opts: {
  method: "GET" | "POST";
  url: string;
  auth: AuthKind;
  body?: unknown;
  streaming?: boolean;
  /** Headers beyond the auth one — an optional protocol header, not a credential. */
  extraHeaders?: Record<string, string>;
}): CodeExample {
  const lines: string[] = [`curl -X ${opts.method}${opts.streaming ? " -N" : ""} '${opts.url}'`];
  if (opts.body !== undefined) {
    lines.push(`  -H 'Content-Type: application/json'`);
  }
  switch (opts.auth) {
    case "token":
      lines.push(`  -H 'Authorization: Bearer ${PLACEHOLDERS.token}'`);
      break;
    case "a2a-key":
      lines.push(`  -H 'X-A2A-Key: ${PLACEHOLDERS.a2aKey}'`);
      break;
    case "trigger-secret":
      lines.push(`  -H 'X-Trigger-Secret: ${PLACEHOLDERS.webhookSecret}'`);
      break;
    case "slack-signature":
      lines.push(`  -H 'X-Slack-Signature: ${PLACEHOLDERS.slackSignature}'`);
      lines.push(`  -H 'X-Slack-Request-Timestamp: ${PLACEHOLDERS.slackTimestamp}'`);
      break;
    case "public":
      break;
  }
  for (const [name, value] of Object.entries(opts.extraHeaders ?? {})) {
    lines.push(`  -H '${name}: ${value}'`);
  }
  if (opts.body !== undefined) {
    lines.push(`  -d '${JSON.stringify(opts.body)}'`);
  }
  return { language: "bash", label: "curl", code: lines.join(" \\\n") };
}

/**
 * OpenAI Python SDK sample for the OpenAI-compatible endpoint. The project API
 * token is passed as `api_key`; the SDK sends it as `Authorization: Bearer`, so
 * only the $PROJECT_API_TOKEN placeholder ever appears.
 */
function pythonSdkExample(opts: {
  baseUrl: string;
  messages: unknown;
  variables?: Record<string, string>;
  stream?: boolean;
}): CodeExample {
  const extraBody = opts.variables ? `,\n    extra_body={"variables": ${JSON.stringify(opts.variables)}}` : "";
  const createArgs = `
    model="",  # ignored — the project version selects the model
    messages=${JSON.stringify(opts.messages)}${extraBody},${opts.stream ? "\n    stream=True," : ""}
`;
  const call = opts.stream
    ? `stream = client.chat.completions.create(${createArgs})
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")`
    : `response = client.chat.completions.create(${createArgs})
print(response.choices[0].message.content)`;
  const code = `from openai import OpenAI

client = OpenAI(
    base_url="${opts.baseUrl}",
    api_key="${PLACEHOLDERS.token}",  # sent as Authorization: Bearer
)

${call}`;
  return { language: "python", label: opts.stream ? "Python (stream)" : "Python", code };
}

/** Node.js OpenAI SDK sample — passes the project token as apiKey. */
function nodeSdkExample(opts: {
  baseUrl: string;
  messages: unknown;
  variables?: Record<string, string>;
  stream?: boolean;
}): CodeExample {
  const extraBody = opts.variables ? `,\n  variables: ${JSON.stringify(opts.variables)},` : "";
  const createArgs = `
  model: "", // ignored — the project version selects the model
  messages: ${JSON.stringify(opts.messages)}${extraBody},${opts.stream ? "\n  stream: true," : ""}
`;
  const call = opts.stream
    ? `const stream = await client.chat.completions.create({${createArgs}});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0].delta.content ?? "");
}`
    : `const response = await client.chat.completions.create({${createArgs}});
console.log(response.choices[0].message.content);`;
  const code = `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${opts.baseUrl}",
  apiKey: "${PLACEHOLDERS.token}", // sent as Authorization: Bearer
});

${call}`;
  return { language: "javascript", label: opts.stream ? "Node.js (stream)" : "Node.js", code };
}

const USAGE_FIELDS: FieldSpec[] = [
  { name: "inputTokens", type: "number", description: "Prompt tokens billed." },
  { name: "outputTokens", type: "number", description: "Completion tokens billed." },
  { name: "costUsd", type: "number", description: "Estimated cost in USD from registry pricing." },
];

export function buildApiReference(ctx: ApiReferenceContext): ApiEndpoint[] {
  const { projectName, projectType, publishedVersion, origin, a2a, slack, webhook } = ctx;
  const abs = (path: string): string => `${origin}${path}`;
  const endpoints: ApiEndpoint[] = [];

  // Execution endpoints target the published version; without one they are hidden.
  if (publishedVersion) {
    const versionBase = `/api/projects/${projectName}/versions/${publishedVersion}`;

    if (projectType === "image") {
      const path = `${versionBase}/predict`;
      const body = { prompt: "a sea otter floating on its back", size: "1024x1024" };
      endpoints.push({
        id: "predict-image",
        method: "POST",
        path,
        title: "Generate image",
        description:
          "Single-shot image run against the published version — draws from the prompt, or edits the attached source images when images is present. The version's system prompt is prepended to the prompt as its persistent style.",
        auth: "token",
        streaming: false,
        requestFields: [
          { name: "prompt", type: "string", required: true, description: "Image generation prompt." },
          {
            name: "images",
            type: "array",
            description:
              "Source images to edit, up to 4 of { b64, mimeType }. Present means edit, absent means draw.",
          },
          { name: "size", type: "string", description: "Requested dimensions, e.g. 1024x1024." },
          { name: "quality", type: "string", description: "Provider-specific quality hint." },
        ],
        responseFields: [
          { name: "imageBase64", type: "string", description: "Base64-encoded image bytes." },
          { name: "mimeType", type: "string", description: "Image MIME type, e.g. image/png." },
          { name: "model", type: "string", description: "Image model that served the call." },
          { name: "usage", type: "object", description: "Token counts and cost.", children: USAGE_FIELDS },
        ],
        responseExample: pretty({
          imageBase64: "<base64>",
          mimeType: "image/png",
          model: "openai/gpt-image-1",
          usage: { inputTokens: 12, outputTokens: 0, costUsd: 0.04 },
        }),
        errorCodes: [400, 401, 404],
        codeExamples: [curlExample({ method: "POST", url: abs(path), auth: "token", body })],
      });
    } else {
      const predictPath = `${versionBase}/predict`;
      const predictBody = { variables: { topic: "otters" }, stream: false };
      endpoints.push({
        id: "predict",
        method: "POST",
        path: predictPath,
        title: "Predict",
        description:
          projectType === "agent"
            ? 'Runs the published version — for an agent project that is the multi-turn tool loop, with its skills, MCP servers and subagents. Set "stream": true for an SSE response.' +
              CONVERSATION_NOTE
            : 'Single-shot run against the published version. Set "stream": true for an SSE response.',
        auth: "token",
        streaming: false,
        requestFields: [
          {
            name: "variables",
            type: "object",
            description:
              projectType === "agent"
                ? "Ignored by agent projects — an agent run has no prompt template to render."
                : "Values substituted into {{var}} placeholders in the prompt template.",
          },
          {
            name: "messages",
            type: "array[object]",
            description:
              projectType === "agent"
                ? "OpenAI-style messages the agent runs against."
                : "Optional OpenAI-style messages appended after the rendered prompt.",
          },
          { name: "stream", type: "boolean", description: "Return an SSE stream instead of one JSON body." },
        ],
        responseFields: [
          { name: "result", type: "string", description: "Assistant text output." },
          { name: "model", type: "string", description: "Model that served the call (provider/model)." },
          { name: "usage", type: "object", description: "Token counts and cost.", children: USAGE_FIELDS },
          {
            name: "finishReason",
            type: "string",
            description:
              'Why the run ended: "completed" when the model finished on its own; "turn-limit" / "output-limit" mark a partial answer stopped at a limit.',
          },
          {
            name: "warnings",
            type: "array[string]",
            description:
              "What the run lost on the way to this answer — a binding no longer in the registry, a blocked MCP server, a clipped transfer transcript. Present only when something was lost; a stream says each of these in a warning frame instead.",
          },
        ],
        responseExample: pretty({
          result: "…assistant text…",
          model: "openai/gpt-5-mini",
          usage: { inputTokens: 12, outputTokens: 34, costUsd: 0.0001 },
          finishReason: "completed",
        }),
        errorCodes: [400, 401, 404],
        codeExamples: [
          curlExample({
            method: "POST",
            url: abs(predictPath),
            auth: "token",
            body: predictBody,
            ...(projectType === "agent" ? { extraHeaders: CONVERSATION_HEADER } : {}),
          }),
        ],
      });

      const ccPath = `${versionBase}/chat/completions`;
      const ccMessages = [{ role: "user", content: "hi" }];
      endpoints.push({
        id: "chat-completions",
        method: "POST",
        path: ccPath,
        title: "OpenAI chat completions",
        description:
          (projectType === "agent"
            ? "OpenAI-compatible endpoint; agent projects run the multi-turn tool loop. "
            : "OpenAI-compatible completion. ") +
          'temperature/max_tokens are accepted but ignored — sampling comes from the version. The same endpoint streams when "stream": true (chat.completion.chunk SSE).' +
          (projectType === "agent" ? CONVERSATION_NOTE : ""),
        auth: "token",
        streaming: false,
        requestFields: [
          { name: "messages", type: "array[object]", required: true, description: "OpenAI chat messages." },
          {
            name: "variables",
            type: "object",
            description: "Values substituted into {{var}} placeholders in the prompt template.",
          },
          {
            name: "stream",
            type: "boolean",
            description: "Emit chat.completion.chunk SSE frames instead of one object.",
          },
        ],
        responseFields: [
          { name: "id", type: "string", description: "Completion id." },
          { name: "object", type: "string", description: '"chat.completion" (or ".chunk" when streaming).' },
          { name: "model", type: "string", description: "Model that served the call." },
          {
            name: "choices",
            type: "array[object]",
            description: "Completion choices.",
            children: [
              { name: "message", type: "object", description: "Assistant message (role, content)." },
              {
                name: "finish_reason",
                type: "string",
                description:
                  '"stop" when the model finished on its own; "length" when the run ended at a limit (its turn budget, or the model\'s output cap).',
              },
            ],
          },
        ],
        responseExample: pretty({
          id: "chatcmpl-…",
          object: "chat.completion",
          model: "openai/gpt-5-mini",
          choices: [
            { index: 0, message: { role: "assistant", content: "…" }, finish_reason: "stop" },
          ],
        }),
        errorCodes: [400, 401, 404],
        codeExamples: [
          curlExample({
            method: "POST",
            url: abs(ccPath),
            auth: "token",
            body: { messages: ccMessages, stream: false },
            ...(projectType === "agent" ? { extraHeaders: CONVERSATION_HEADER } : {}),
          }),
          pythonSdkExample({ baseUrl: abs(versionBase), messages: ccMessages }),
          pythonSdkExample({ baseUrl: abs(versionBase), messages: ccMessages, stream: true }),
          nodeSdkExample({ baseUrl: abs(versionBase), messages: ccMessages }),
          nodeSdkExample({ baseUrl: abs(versionBase), messages: ccMessages, stream: true }),
        ],
      });

      if (projectType === "agent") {
        const agentPath = `${versionBase}/agent`;
        const agentBody = { messages: [{ role: "user", content: "hi" }] };
        endpoints.push({
          id: "agent",
          method: "POST",
          path: agentPath,
          title: "Agent stream",
          description:
            "SSE stream of EngineChunk frames (delta.content, toolResult, warning, author for subagent turns, error, and a terminal done: true or finishReason naming why the run ended), terminated by data: [DONE]." +
            CONVERSATION_NOTE,
          auth: "token",
          streaming: true,
          requestFields: [
            { name: "messages", type: "array[object]", required: true, description: "Conversation so far." },
          ],
          errorCodes: [400, 401, 404],
          codeExamples: [
            curlExample({
              method: "POST",
              url: abs(agentPath),
              auth: "token",
              body: agentBody,
              streaming: true,
              extraHeaders: CONVERSATION_HEADER,
            }),
          ],
        });
      }
    }
  }

  // The project webhook: shown once it is switched on, and deliberately not
  // gated on a published version — the address is live either way, and what it
  // answers without one is the `no-published-version` status documented below.
  if (webhook && webhook.enabled) {
    const webhookPath = projectWebhookPath(projectName);
    const webhookBody = { event: "build.finished", status: "ok" };
    endpoints.push({
      id: "webhook",
      method: "POST",
      path: webhookPath,
      title: "Project webhook",
      description:
        "Starts a run of the published version from outside. The secret goes in X-Trigger-Secret; the JSON body (up to 1MB) becomes the run's input — serialised into the user message, or turned into template variables when the webhook's payload mode says so. " +
        "It answers 202 immediately and runs in the background, because a run can take minutes and no sender waits that long: the answer lands on the delivery's history row under Settings → Webhook, not in this response. " +
        "Send an Idempotency-Key header to make a redelivery safe — a repeat within 24 hours is acknowledged as duplicate without running.",
      auth: "trigger-secret",
      streaming: false,
      responseFields: [
        { name: "ok", type: "boolean", description: "Always true — the delivery was understood." },
        {
          name: "status",
          type: "string",
          description:
            '"accepted" when a run started; "disabled", "duplicate", "busy" (a run from this webhook was still going and overlap is off) or "no-published-version" when it deliberately did not. All four are 202: the delivery was fine, the run is what did not happen.',
        },
        {
          name: "runId",
          type: "string",
          description: 'Present on "accepted" — the id of the history row this delivery opened.',
        },
      ],
      responseExample: pretty({ ok: true, status: "accepted", runId: "9f1c…" }),
      errorCodes: [400, 401, 404, 413],
      codeExamples: [
        curlExample({
          method: "POST",
          url: abs(webhookPath),
          auth: "trigger-secret",
          extraHeaders: { "Idempotency-Key": "$DELIVERY_ID" },
          body: webhookBody,
        }),
      ],
    });
  }

  // A2A endpoints appear only when the key is configured and a version is published.
  if (a2a && a2a.enabled && a2a.published) {
    const cardPath = `/api/a2a/${projectName}/.well-known/agent-card.json`;
    endpoints.push({
      id: "a2a-card",
      method: "GET",
      path: cardPath,
      title: "A2A Agent Card",
      description: "Public Agent Card describing this project as an A2A agent.",
      auth: "public",
      streaming: false,
      responseExample: pretty({
        name: projectName,
        description: "…",
        url: abs(`/api/a2a/${projectName}`),
      }),
      errorCodes: [404],
      codeExamples: [curlExample({ method: "GET", url: abs(cardPath), auth: "public" })],
    });

    const rpcPath = `/api/a2a/${projectName}`;
    const rpcBody = {
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: { message: { role: "user", parts: [{ kind: "text", text: "hi" }] } },
    };
    endpoints.push({
      id: "a2a-rpc",
      method: "POST",
      path: rpcPath,
      title: "A2A JSON-RPC",
      description:
        "JSON-RPC endpoint (message/send, message/stream, tasks/get, tasks/cancel), authenticated with the X-A2A-Key header.",
      auth: "a2a-key",
      streaming: false,
      requestFields: [
        { name: "jsonrpc", type: "string", required: true, description: 'Must be "2.0".' },
        { name: "method", type: "string", required: true, description: "message/send | message/stream | tasks/get | tasks/cancel." },
        { name: "params", type: "object", required: true, description: "Method params (e.g. the A2A message)." },
      ],
      errorCodes: [401, 503],
      codeExamples: [curlExample({ method: "POST", url: abs(rpcPath), auth: "a2a-key", body: rpcBody })],
    });
  }

  // Slack webhook is shown to the owner once a bot is configured.
  if (slack && slack.configured) {
    const eventsPath = `/api/slack/events/${projectName}`;
    endpoints.push({
      id: "slack-events",
      method: "POST",
      path: eventsPath,
      title: "Slack events webhook",
      description:
        "Slack delivers app_mention, message.im and message.channels/message.groups events here. Requests are verified with this project's Slack signing secret (HMAC) — it is not called manually. Most channel messages are answered with ok and nothing else: only a mention, a DM, a follow-up in a thread the bot answered in, or a project keyword starts a run.",
      auth: "slack-signature",
      streaming: false,
      errorCodes: [401],
      codeExamples: [
        curlExample({
          method: "POST",
          url: abs(eventsPath),
          auth: "slack-signature",
          body: { type: "event_callback", event: { type: "app_mention", text: "<@bot> hi" } },
        }),
      ],
    });
  }

  return endpoints;
}
