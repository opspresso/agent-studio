import { agentWebhookPath } from "@/domain/trigger/types";
import { MAX_DOCUMENTS, MAX_DOCUMENT_SIZE_LABEL } from "@/domain/llm/documentLimits";

/**
 * Builds the API Reference tab's endpoint descriptors from an Agent's public
 * context (name, saved settings, integration flags). This module is
 * intentionally pure — it takes **no** secrets, so every rendered example and
 * code sample can only ever contain the placeholder tokens below, never a real
 * session cookie or Slack secret.
 */

export type AuthKind =
  | "token"
  | "trigger-secret"
  | "slack-signature"
  | "telegram-secret"
  | "teams-token"
  | "public";

export const AUTH_LABEL: Record<AuthKind, string> = {
  token: "Bearer token",
  "trigger-secret": "X-Trigger-Secret or GitHub X-Hub-Signature-256",
  "slack-signature": "Slack signature",
  "telegram-secret": "Telegram secret token",
  "teams-token": "Bot Framework token",
  public: "Public",
};

/** Placeholder tokens — the only credential-shaped strings any example may contain. */
export const PLACEHOLDERS = {
  token: "$AGENT_API_TOKEN",
  webhookSecret: "$WEBHOOK_SECRET",
  slackSignature: "$SLACK_SIGNATURE",
  slackTimestamp: "$SLACK_TIMESTAMP",
  telegramSecret: "$TELEGRAM_WEBHOOK_SECRET",
  teamsToken: "$BOT_FRAMEWORK_TOKEN",
} as const;

/**
 * The optional conversation header reaches MCP calls.
 * It does not persist the calling client's model history.
 */
const CONVERSATION_HEADER = { "X-Conversation-Id": "$CONVERSATION_ID" } as const;
const CONVERSATION_NOTE =
  " Send the same X-Conversation-Id on follow-up questions so MCP servers know which conversation is asking. Optional; without it each request is its own conversation.";

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
  agentName: string;
  /** Whether the Agent has saved settings that can be executed. */
  configured: boolean;
  /** Absolute origin for example URLs (e.g. window.location.origin); "" is tolerated. */
  origin: string;
  /**
   * The Agent webhook's switch, or null when not visible to the viewer — the
   * secret it is authenticated with is owner-readable, so a viewer who cannot
   * see the switch has nothing to call this endpoint with.
   */
  webhook: { enabled: boolean } | null;
  /** Slack integration status (owner or admin), or null when not visible to the viewer. */
  slack: { configured: boolean } | null;
  /** Telegram integration status (owner or admin), or null when not visible to the viewer. */
  telegram: { configured: boolean } | null;
  /** Teams integration status (owner or admin), or null when not visible to the viewer. */
  teams: { configured: boolean } | null;
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
      lines.push(`  -H "Authorization: Bearer ${PLACEHOLDERS.token}"`);
      break;
    case "trigger-secret":
      lines.push(`  -H "X-Trigger-Secret: ${PLACEHOLDERS.webhookSecret}"`);
      break;
    case "slack-signature":
      lines.push(`  -H "X-Slack-Signature: ${PLACEHOLDERS.slackSignature}"`);
      lines.push(`  -H "X-Slack-Request-Timestamp: ${PLACEHOLDERS.slackTimestamp}"`);
      break;
    case "telegram-secret":
      lines.push(`  -H "X-Telegram-Bot-Api-Secret-Token: ${PLACEHOLDERS.telegramSecret}"`);
      break;
    case "teams-token":
      lines.push(`  -H "Authorization: Bearer ${PLACEHOLDERS.teamsToken}"`);
      break;
    case "public":
      break;
  }
  for (const [name, value] of Object.entries(opts.extraHeaders ?? {})) {
    lines.push(`  -H "${name}: ${value}"`);
  }
  if (opts.body !== undefined) {
    lines.push(`  -d '${JSON.stringify(opts.body)}'`);
  }
  return { language: "bash", label: "curl", code: lines.join(" \\\n") };
}

/**
 * OpenAI Python SDK sample for the OpenAI-compatible endpoint. The Agent API
 * token is passed as `api_key`; the SDK sends it as `Authorization: Bearer`, so
 * the credential is read from the calling process's environment.
 */
function pythonSdkExample(opts: {
  baseUrl: string;
  messages: unknown;
  stream?: boolean;
  /** Show the conversation header, per call — the SDK's `extra_headers`. */
  conversation?: boolean;
}): CodeExample {
  const extraHeaders = opts.conversation
    ? `\n    extra_headers={"X-Conversation-Id": os.environ["CONVERSATION_ID"]},  # same value on every turn of one conversation`
    : "";
  const createArgs = `
    model="",  # ignored — the Agent configuration selects the model
    messages=${JSON.stringify(opts.messages)},${opts.stream ? "\n    stream=True," : ""}${extraHeaders}
`;
  const call = opts.stream
    ? `stream = client.chat.completions.create(${createArgs})
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")`
    : `response = client.chat.completions.create(${createArgs})
print(response.choices[0].message.content)`;
  const code = `import os
from openai import OpenAI

client = OpenAI(
    base_url="${opts.baseUrl}",
    api_key=os.environ["AGENT_API_TOKEN"],  # sent as Authorization: Bearer
)

${call}`;
  return { language: "python", label: opts.stream ? "Python (stream)" : "Python", code };
}

/** Node.js OpenAI SDK sample — passes the Agent token as apiKey. */
function nodeSdkExample(opts: {
  baseUrl: string;
  messages: unknown;
  stream?: boolean;
  /** Show the conversation header, per call — the SDK's request options. */
  conversation?: boolean;
}): CodeExample {
  const createArgs = `
  model: "", // ignored — the Agent configuration selects the model
  messages: ${JSON.stringify(opts.messages)},${opts.stream ? "\n  stream: true," : ""}
`;
  const requestOptions = opts.conversation
    ? `, {
  headers: { "X-Conversation-Id": process.env.CONVERSATION_ID }, // same value on every turn of one conversation
}`
    : "";
  const call = opts.stream
    ? `const stream = await client.chat.completions.create({${createArgs}}${requestOptions});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0].delta.content ?? "");
}`
    : `const response = await client.chat.completions.create({${createArgs}}${requestOptions});
console.log(response.choices[0].message.content);`;
  const code = `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${opts.baseUrl}",
  apiKey: process.env.AGENT_API_TOKEN, // sent as Authorization: Bearer
});

${call}`;
  return { language: "javascript", label: opts.stream ? "Node.js (stream)" : "Node.js", code };
}

const USAGE_FIELDS: FieldSpec[] = [
  { name: "inputTokens", type: "number", description: "Prompt tokens billed." },
  { name: "outputTokens", type: "number", description: "Completion tokens billed." },
  { name: "cachedTokens", type: "number", description: "Optional cached subset of inputTokens; do not add it to the total." },
  { name: "reasoningTokens", type: "number", description: "Optional reasoning subset of outputTokens; do not add it to the total." },
  { name: "costUsd", type: "number", description: "Aggregate run cost: text calls prefer provider-reported cost; registry pricing covers fallbacks and image calls." },
];

const DOCUMENTS_FIELD: FieldSpec = {
  name: "documents", type: "array[object]",
  description: `Optional document attachments: at most ${MAX_DOCUMENTS}, each up to ${MAX_DOCUMENT_SIZE_LABEL}. Extracted text is appended to the latest user message, or a user turn is added if absent.`,
  children: [
    { name: "b64", type: "string", required: true, description: "Base64-encoded document bytes, without a data URL prefix." },
    { name: "mimeType", type: "string", required: true, description: "Document MIME type; the filename is also checked for format recognition." },
    { name: "name", type: "string", required: true, description: "Filename including its extension." },
  ],
};

const OUTPUT_FIELDS: FieldSpec[] = [
  { name: "images", type: "array[object]", description: "Generated or edited images: { b64, mimeType, prompt? }. Present only when the run produced images." },
  { name: "files", type: "array[object]", description: "Addressed files: { fileId, name, mimeType, byteSize?, url }. Download before the signed URL expires; fileId supports authorized follow-up tool calls." },
];

export function buildApiReference(ctx: ApiReferenceContext): ApiEndpoint[] {
  const { agentName, configured, origin, slack, telegram, teams, webhook } = ctx;
  const abs = (path: string): string => `${origin}${path}`;
  const endpoints: ApiEndpoint[] = [];

  // Execution endpoints target the current Agent configuration; without one they are hidden.
  if (configured) {
    const agentBase = `/api/agents/${agentName}`;

    {
      const predictPath = `${agentBase}/predict`;
      const predictBody = { messages: [{ role: "user", content: "Tell me about otters." }], stream: false };
      endpoints.push({
        id: "predict",
        method: "POST",
        path: predictPath,
        title: "Predict",
        description:
          'Runs the Agent tool loop with its skills, MCP servers and subagents. Set "stream": true for an SSE response.' + CONVERSATION_NOTE,
        auth: "token",
        streaming: false,
        requestFields: [
          {
            name: "messages",
            type: "array[object]",
            required: true,
            description:
              "OpenAI-style messages the Agent runs against.",
          },
          { name: "stream", type: "boolean", description: "Return an SSE stream instead of one JSON body." },
          DOCUMENTS_FIELD,
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
          ...OUTPUT_FIELDS,
        ],
        responseExample: pretty({
          result: "…assistant text…",
          model: "openai/gpt-5-mini",
          usage: { inputTokens: 12, outputTokens: 34, costUsd: 0.0001 },
          finishReason: "completed",
        }),
        errorCodes: [400, 401, 403, 404, 413, 429, 500, 502, 503, 504],
        codeExamples: [
          curlExample({
            method: "POST",
            url: abs(predictPath),
            auth: "token",
            body: predictBody,
            extraHeaders: CONVERSATION_HEADER,
          }),
        ],
      });

      const ccPath = `${agentBase}/chat/completions`;
      const ccMessages = [{ role: "user", content: "hi" }];
      endpoints.push({
        id: "chat-completions",
        method: "POST",
        path: ccPath,
        title: "OpenAI chat completions",
        description:
          "OpenAI-compatible endpoint; Agents run the multi-turn tool loop. " +
          'temperature/max_tokens are accepted but ignored — sampling comes from Agent settings. The same endpoint streams when "stream": true (chat.completion.chunk SSE); image/file/warning extensions then appear in choices[0].delta and usage frames are not emitted.' +
          CONVERSATION_NOTE,
        auth: "token",
        streaming: false,
        requestFields: [
          { name: "model", type: "string", description: "Accepted for SDK compatibility; the Agent's saved model is used." },
          { name: "messages", type: "array[object]", required: true, description: "OpenAI chat messages." },
          {
            name: "stream",
            type: "boolean",
            description: "Emit chat.completion.chunk SSE frames instead of one object.",
          },
          { name: "temperature", type: "number", description: "Accepted and ignored; sampling uses saved Agent settings." },
          { name: "max_tokens", type: "number", description: "Accepted and ignored; the output cap uses saved Agent settings." },
        ],
        responseFields: [
          { name: "id", type: "string", description: "Completion id." },
          { name: "object", type: "string", description: '"chat.completion" (or ".chunk" when streaming).' },
          { name: "created", type: "number", description: "Response creation time, in Unix seconds." },
          { name: "model", type: "string", description: "Model that served the call." },
          {
            name: "choices",
            type: "array[object]",
            description: "Collected choices carry message; streaming choices carry delta.",
            children: [
              { name: "index", type: "number", description: "Choice index, currently 0." },
              { name: "delta", type: "object", description: "Streaming only: role, content and optional images/files/warnings extensions." },
              { name: "message", type: "object", description: "Assistant message (role, content)." },
              {
                name: "finish_reason",
                type: "string",
                description:
                  '"stop" when the model finished on its own; "length" when the run ended at a limit (its turn budget, or the model\'s output cap).',
              },
            ],
          },
          { name: "usage", type: "object", description: "Collected responses include prompt_tokens, completion_tokens, total_tokens, and optional completion_tokens_details.reasoning_tokens. Streaming responses do not include usage frames." },
          { name: "warnings", type: "array[string]", description: "Loss warnings; streaming responses carry these in choices[0].delta.warnings." },
          ...OUTPUT_FIELDS,
        ],
        responseExample: pretty({
          id: "chatcmpl-…",
          object: "chat.completion",
          created: 1780000000,
          model: "openai/gpt-5-mini",
          usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
          choices: [
            { index: 0, message: { role: "assistant", content: "…" }, finish_reason: "stop" },
          ],
        }),
        errorCodes: [400, 401, 403, 404, 413, 429, 500, 502, 503, 504],
        codeExamples: [
          curlExample({
            method: "POST",
            url: abs(ccPath),
            auth: "token",
            body: { messages: ccMessages, stream: false },
            extraHeaders: CONVERSATION_HEADER,
          }),
          pythonSdkExample({ baseUrl: abs(agentBase), messages: ccMessages, conversation: true }),
          pythonSdkExample({ baseUrl: abs(agentBase), messages: ccMessages, stream: true, conversation: true }),
          nodeSdkExample({ baseUrl: abs(agentBase), messages: ccMessages, conversation: true }),
          nodeSdkExample({ baseUrl: abs(agentBase), messages: ccMessages, stream: true, conversation: true }),
        ],
      });

      {
        const agentPath = `${agentBase}/agent`;
        const agentBody = { messages: [{ role: "user", content: "hi" }] };
        endpoints.push({
          id: "agent",
          method: "POST",
          path: agentPath,
          title: "Agent stream",
          description:
            "SSE stream of EngineChunk frames (delta.content, delta.reasoningContent when enabled, toolResult, image, file, usage, warning, author for subagent turns, error, and a terminal done: true or finishReason naming why the run ended), terminated by data: [DONE]. Once the stream opens, failures are error frames rather than a new HTTP status." +
            CONVERSATION_NOTE,
          auth: "token",
          streaming: true,
          requestFields: [
            { name: "messages", type: "array[object]", required: true, description: "Conversation so far." },
            DOCUMENTS_FIELD,
          ],
          errorCodes: [400, 401, 403, 404, 413, 429, 500, 503],
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

  // The Agent webhook: shown once it is switched on, and deliberately not
  // gated on saved Agent settings — the address is live either way, and what it
  // answers without one is the `no-configuration` status documented below.
  if (webhook && webhook.enabled) {
    const webhookPath = agentWebhookPath(agentName);
    const webhookBody = { event: "build.finished", status: "ok" };
    endpoints.push({
      id: "webhook",
      method: "POST",
      path: webhookPath,
      title: "Agent webhook",
      description:
        "Starts a run of the current Agent configuration from outside. Generic senders use X-Trigger-Secret. GitHub uses the same secret in its Secret setting to sign X-Hub-Signature-256, with X-GitHub-Delivery and X-GitHub-Event headers; the JSON body (up to 1MB) becomes the run's input — serialised into the user message. " +
        "It answers 202 immediately and runs in the background, because a run can take minutes and no sender waits that long: the answer lands on the delivery's history row under Settings → Webhook, not in this response. " +
        "Generic senders use Idempotency-Key; GitHub redeliveries are deduplicated by X-GitHub-Delivery for 24 hours. Signed GitHub ping deliveries return status=ping without starting a run.",
      auth: "trigger-secret",
      streaming: false,
      responseFields: [
        { name: "ok", type: "boolean", description: "Always true — the delivery was understood." },
        {
          name: "status",
          type: "string",
          description:
            '"accepted" when a run started; "disabled", "duplicate", "busy" (overlap is off), "no-configuration" or "ping" when no run starts. These acknowledgements return 202.',
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

  // Slack webhook is shown to the owner once a bot is configured.
  if (slack && slack.configured) {
    const eventsPath = `/api/slack/events/${agentName}`;
    endpoints.push({
      id: "slack-events",
      method: "POST",
      path: eventsPath,
      title: "Slack events webhook",
      description:
        "Slack delivers app_mention, message.im and message.channels/message.groups events here. Requests are verified with this Agent's Slack signing secret (HMAC) — it is not called manually. Most channel messages are answered with ok and nothing else: only a mention, a DM, a follow-up in a thread the bot answered in, or an Agent keyword starts a run.",
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

  // The Telegram webhook is shown to the owner once a bot is configured.
  if (telegram && telegram.configured) {
    const webhookPath = `/api/telegram/webhook/${agentName}`;
    endpoints.push({
      id: "telegram-webhook",
      method: "POST",
      path: webhookPath,
      title: "Telegram webhook",
      description:
        "Telegram delivers message updates here once the bot is enabled on the Integrations tab. Requests are verified with the secret token this platform registered the webhook with — it is not called manually. A private-chat message with a sender ID starts a run; in a group only a message from an identified sender that mentions the bot or replies to one of its messages does, and /start and /help are answered without one.",
      auth: "telegram-secret",
      streaming: false,
      errorCodes: [401],
      codeExamples: [
        curlExample({
          method: "POST",
          url: abs(webhookPath),
          auth: "telegram-secret",
          body: {
            update_id: 1,
            message: { message_id: 1, chat: { id: 1, type: "private" }, from: { id: 1 }, text: "hi" },
          },
        }),
      ],
    });
  }

  // The Teams messaging endpoint is shown to the owner once a bot is configured.
  if (teams && teams.configured) {
    const messagingPath = `/api/teams/messages/${agentName}`;
    endpoints.push({
      id: "teams-messages",
      method: "POST",
      path: messagingPath,
      title: "Microsoft Teams messaging endpoint",
      description:
        "The Bot Framework delivers Teams activities here — set this URL as the Azure Bot's messaging endpoint. Requests are verified with the token the Bot Framework signs for this bot's App ID and serviceUrl — it is not called manually. A personal-chat message with a sender ID starts a run; in a channel or group chat only a message from an identified sender that @mentions the bot does.",
      auth: "teams-token",
      streaming: false,
      errorCodes: [401],
      codeExamples: [
        curlExample({
          method: "POST",
          url: abs(messagingPath),
          auth: "teams-token",
          body: {
            type: "message",
            id: "1",
            serviceUrl: "https://smba.trafficmanager.net/emea/",
            conversation: { id: "a:1", conversationType: "personal" },
            from: { id: "29:1", name: "Someone" },
            recipient: { id: "28:app-id" },
            text: "hi",
          },
        }),
      ],
    });
  }

  return endpoints;
}
