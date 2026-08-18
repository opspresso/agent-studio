/**
 * Diff the model registry against the models the configured LLM channels serve.
 *
 * The registry (`src/domain/llm/models.ts`) is hand-maintained and has to be:
 * pricing, context windows, and capability flags exist only in each provider's
 * documentation, so they cannot be synced from an API. Model *ids* can be, and
 * that is the part that goes stale silently — a provider ships a model, nobody
 * notices, and the first symptom is a run booked at $0. This reports the two
 * lists and leaves every judgement to a human:
 *
 *   - served by a channel, absent from the registry  → candidate to add
 *   - in the registry, served by no channel          → candidate to retire
 *
 *   pnpm check-models                    # report; always exits 0
 *   pnpm check-models --since=90d        # only models released in the last 90 days
 *   pnpm check-models --since=2026-01-01 # ...or since a date
 *   pnpm check-models --strict           # exit 1 on a registered model nothing serves,
 *                                        #   or on a channel that failed; with --since,
 *                                        #   also on anything newly released
 *
 * The registry is a *curated* selection, not a mirror: a provider channel serves
 * its entire catalog — embeddings, speech, moderation, fine-tunes, every dated
 * snapshot and superseded generation — and almost none of it is a model this app
 * should offer. So the first list is long by nature and is sorted newest-first
 * with each model's release date, which is the ordering that puts "they shipped
 * something we missed" at the top. `--since` narrows it; nothing is ever dropped
 * silently.
 *
 * Ids are compared in the `provider/model` form the registry uses. A provider
 * channel serves bare ids, so its ids are re-prefixed the same way
 * `resolveProviderTarget` strips them — otherwise every model behind a direct
 * channel would read as missing. Ids outside `SUPPORTED_PROVIDERS` are ignored.
 */
import { MODEL_CONFIGS, SUPPORTED_PROVIDERS } from "@/domain/llm/models";
import { AWS_SIGNING_SERVICE, createSignedFetch } from "@/infrastructure/llm/awsSigner";
import type { ChannelAuth, ProviderChannelConfig } from "@/domain/settings/types";

/** Anthropic requires an explicit API version on every request. */
const ANTHROPIC_VERSION = "2023-06-01";

interface Channel {
  label: string;
  baseUrl: string;
  apiKey: string;
  /** Provider whose bare ids need re-prefixing; null for the default channel. */
  provider: string | null;
  keepModelPrefix: boolean;
  auth: ChannelAuth;
}

/** A model a channel serves, in registry id form. */
interface ServedModel {
  id: string;
  /** Release time in epoch ms, or null when the channel does not report one. */
  releasedAt: number | null;
}

/**
 * Effective channel configuration. Runtime settings own the DB-override →
 * env-fallback precedence, so this asks them rather than reading the env
 * itself; when the settings row is unreachable (no AWS credentials, running
 * against a laptop with no DynamoDB) it degrades to the env channels instead of
 * refusing to run — a report from the env channels is still useful.
 */
async function resolveChannels(): Promise<Channel[]> {
  const { config } = await import("@/lib/config");
  let base: { baseUrl: string; apiKey: string };
  let providers: ProviderChannelConfig[];
  try {
    const settings = await import("@/lib/runtime-settings");
    base = await settings.getLlmChannelConfig();
    providers = await settings.getLlmProviderConfigs();
  } catch (error) {
    console.warn(
      `! stored settings unreachable (${error instanceof Error ? error.message : String(error)}); using environment channels only\n`,
    );
    const { parseProviderConfigs } = await import("@/infrastructure/llm/providers");
    base = { baseUrl: config.llmBaseUrl, apiKey: config.llmApiKey };
    providers = parseProviderConfigs(process.env);
  }

  return [
    {
      label: "default",
      baseUrl: base.baseUrl,
      apiKey: base.apiKey,
      provider: null,
      keepModelPrefix: true,
      auth: "bearer",
    },
    ...providers.map((provider) => ({
      label: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      provider: provider.name,
      keepModelPrefix: provider.keepModelPrefix === true,
      auth: provider.auth,
    })),
  ];
}

/**
 * Anthropic's own endpoint predates the OpenAI-compatible convention: it
 * authenticates with `x-api-key` and rejects a bearer token outright (401
 * "Invalid bearer token"). Every other channel, routers included, takes the
 * OpenAI form.
 *
 * Which one this is cannot be read off the provider name — a gateway may well
 * be registered under `LLM_PROVIDER_ANTHROPIC_*`, and sending it `x-api-key`
 * earns a 401 that this script would report as a dead channel, taking `--strict`
 * red on a healthy configuration. `keepModelPrefix` is what actually says: a
 * channel handed `anthropic/claude-…` cannot be Anthropic's API, which 404s on
 * that spelling. So the `x-api-key` form is used only where the prefix is
 * stripped — exactly where dispatch would be talking to Anthropic directly.
 */
function authHeaders(channel: Channel): Record<string, string> {
  if (channel.auth === "sigv4") {
    // The signer sets the header; anything put here would be overwritten by it.
    return {};
  }
  if (channel.provider === "anthropic" && !channel.keepModelPrefix) {
    return { "x-api-key": channel.apiKey, "anthropic-version": ANTHROPIC_VERSION };
  }
  return { Authorization: `Bearer ${channel.apiKey}` };
}

/** Release time in epoch ms: OpenAI reports unix seconds, Anthropic an ISO string. */
function parseReleasedAt(entry: Record<string, unknown>): number | null {
  if (typeof entry.created === "number" && Number.isFinite(entry.created)) {
    return entry.created * 1000;
  }
  if (typeof entry.created_at === "string") {
    const parsed = Date.parse(entry.created_at);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return null;
}

/** A runaway `has_more` must not spin; far more pages than any catalog needs. */
const MAX_PAGES = 25;

/**
 * Every model a channel serves.
 *
 * Anthropic paginates this endpoint (`has_more` plus a `last_id` cursor, twenty
 * per page by default); OpenAI returns the lot. The first request is made the
 * way it always was and the cursor is followed only when one is offered, so a
 * channel that does not paginate behaves exactly as before. Reading page one and
 * stopping would report a provider's own live models as retired — in the list
 * whose whole purpose is to be trusted enough to delete from.
 */
async function fetchModels(channel: Channel): Promise<ServedModel[]> {
  const endpoint = `${channel.baseUrl.replace(/\/+$/, "")}/models`;
  const collected: ServedModel[] = [];
  let cursor: string | undefined;
  // A signed channel has no key to put in a header; the same signer the runtime
  // dispatches through is what makes this readable. Without it the channel
  // answers 403 and gets reported as dead, which under `--strict` fails the run
  // on a healthy configuration.
  const request =
    channel.auth === "sigv4" ? createSignedFetch(AWS_SIGNING_SERVICE) : globalThis.fetch;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = cursor ? `${endpoint}?after_id=${encodeURIComponent(cursor)}` : endpoint;
    const response = await request(url, { headers: authHeaders(channel) });
    if (!response.ok) {
      throw new Error(`GET ${url} → ${response.status} ${response.statusText}`);
    }
    const body = (await response.json()) as {
      data?: unknown;
      has_more?: unknown;
      last_id?: unknown;
    };
    if (!Array.isArray(body.data)) {
      throw new Error(`GET ${url} → no "data" array in the response`);
    }
    for (const entry of body.data) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const record = entry as Record<string, unknown>;
      if (typeof record.id !== "string" || record.id.length === 0) {
        continue;
      }
      collected.push({ id: qualify(record.id, channel), releasedAt: parseReleasedAt(record) });
    }
    if (body.has_more !== true || typeof body.last_id !== "string" || body.last_id === "") {
      return [...collected, ...(await fetchImageModels(channel, request))];
    }
    cursor = body.last_id;
  }
  throw new Error(`GET ${endpoint} → still paginating after ${MAX_PAGES} pages`);
}

/**
 * The drawing models a channel keeps in a second catalog.
 *
 * OpenRouter lists its dedicated image models at `/images/models` and *not* in
 * `/models`: `openai/gpt-image-2` and both Grok drawing models are registered
 * against that channel and appear only there. Without this they read as served
 * by nothing — "candidate to retire" for three models that work, and a
 * `--strict` failure on a healthy configuration.
 *
 * A channel without that catalog answers 404, which is an answer rather than a
 * failure — the four provider-direct channels and Bedrock's mantle endpoint all
 * do. Any other status is a channel not answering, and is raised like one.
 */
async function fetchImageModels(channel: Channel, request: typeof globalThis.fetch): Promise<ServedModel[]> {
  const url = `${channel.baseUrl.replace(/\/+$/, "")}/images/models`;
  const response = await request(url, { headers: authHeaders(channel) });
  if (response.status === 404) {
    return [];
  }
  if (!response.ok) {
    throw new Error(`GET ${url} → ${response.status} ${response.statusText}`);
  }
  const body = (await response.json()) as { data?: unknown };
  if (!Array.isArray(body.data)) {
    throw new Error(`GET ${url} → no "data" array in the response`);
  }
  const collected: ServedModel[] = [];
  for (const entry of body.data) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.length === 0) {
      continue;
    }
    collected.push({ id: qualify(record.id, channel), releasedAt: parseReleasedAt(record) });
  }
  return collected;
}

/**
 * Registry ids keyed by the `provider/wireId` a provider-direct channel serves
 * them under. Without this a model whose provider names it differently reads as
 * both missing (under the provider's name) and retired (under the registry's) —
 * two findings for a model that is registered and served.
 */
const BY_WIRE_ID = new Map(
  MODEL_CONFIGS.filter((model) => model.wireId !== undefined).map((model) => [
    `${model.provider}/${model.wireId}`,
    model.id,
  ]),
);

/** The registry id a served `provider/model` id belongs to, if it has one. */
function toRegistryId(qualified: string): string {
  return BY_WIRE_ID.get(qualified) ?? qualified;
}

/** Re-prefix a bare id from a provider channel into the registry's id form. */
function qualify(id: string, channel: Channel): string {
  if (channel.provider === null || channel.keepModelPrefix) {
    return id;
  }
  return toRegistryId(id.startsWith(`${channel.provider}/`) ? id : `${channel.provider}/${id}`);
}

/**
 * `<alias>-<date>`, the dated-snapshot form both OpenAI and Anthropic use.
 * The date is required: a bare prefix match would let `gpt-5` be satisfied by
 * `gpt-5-mini`.
 */
const DATED_SNAPSHOT = /^(.*)-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;

/** The undated alias a dated snapshot id belongs to, or null. */
function aliasOf(id: string): string | null {
  return DATED_SNAPSHOT.exec(id)?.[1] ?? null;
}

/**
 * The registry id a snapshot's alias stands for, or null if it is not a
 * snapshot.
 *
 * The date comes off the provider's own spelling, so the alias is still in it —
 * and `served` is keyed by registry ids, because `qualify` already mapped them.
 * Comparing the two without this step reports every dated snapshot of a `wireId`
 * model as missing: Anthropic serves `claude-haiku-4-5-20251001`, whose alias is
 * `claude-haiku-4-5`, while the registry holds `claude-haiku-4.5`.
 */
function aliasRegistryId(id: string): string | null {
  const alias = aliasOf(id);
  return alias === null ? null : toRegistryId(alias);
}

function isSelectable(id: string): boolean {
  const slash = id.indexOf("/");
  return slash > 0 && (SUPPORTED_PROVIDERS as readonly string[]).includes(id.slice(0, slash));
}

/** `--since=90d` or `--since=2026-01-01` → epoch ms cutoff. */
function parseSince(argv: string[]): number | null {
  const arg = argv.find((value) => value.startsWith("--since="));
  if (!arg) {
    return null;
  }
  const raw = arg.slice("--since=".length);
  const days = /^(\d+)d$/.exec(raw);
  if (days?.[1]) {
    return Date.now() - Number(days[1]) * 86_400_000;
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`--since expects <N>d or a date, got "${raw}"`);
  }
  return parsed;
}

function formatDate(releasedAt: number | null): string {
  return releasedAt === null ? "    ?     " : new Date(releasedAt).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const strict = process.argv.includes("--strict");
  const since = parseSince(process.argv);
  const channels = await resolveChannels();

  const served = new Map<string, number | null>();
  let anyChannelFailed = false;
  for (const channel of channels) {
    try {
      const models = await fetchModels(channel);
      const selectable = models.filter((model) => isSelectable(model.id));
      for (const model of selectable) {
        // Two channels may both serve an id. Keep the earliest release, because
        // a later date is a re-list rather than a new model — and because the
        // alternative is a date decided by channel iteration order, which the
        // `--since` cutoff would then act on.
        const existing = served.get(model.id);
        if (existing === undefined) {
          served.set(model.id, model.releasedAt);
        } else if (model.releasedAt !== null && (existing === null || model.releasedAt < existing)) {
          served.set(model.id, model.releasedAt);
        }
      }
      console.log(
        `${channel.label} channel (${channel.baseUrl}): ${models.length} models, ${selectable.length} selectable`,
      );
    } catch (error) {
      anyChannelFailed = true;
      console.log(
        `${channel.label} channel (${channel.baseUrl}): FAILED — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const registered = new Map(MODEL_CONFIGS.map((model) => [model.id, model]));

  // A provider that lists only dated snapshots still serves the undated alias:
  // Anthropic's catalog names `claude-haiku-4-5-20251001`, yet dispatching
  // `claude-haiku-4-5` succeeds. Without crediting the alias, every such model
  // reads as retired — a false positive in the one list that invites deleting a
  // live model. Aliases only satisfy registry entries; they are never treated as
  // models observed in their own right.
  const covered = new Set(served.keys());
  for (const id of served.keys()) {
    const alias = aliasRegistryId(id);
    if (alias !== null) {
      covered.add(alias);
    }
  }

  const unregistered = [...served.entries()].filter(([id]) => !registered.has(id));
  /**
   * A snapshot is the model its alias names, not a second one to decide about.
   *
   * Folded when that alias is registered *or* served. Registered matters on its
   * own because a provider may list only the dated form: Anthropic serves
   * `claude-haiku-4-5-20251001` and no undated alias, so asking "is the alias
   * served" leaves a model the registry already holds sitting in the list of
   * models it lacks.
   */
  const foldsAway = (id: string): boolean => {
    const alias = aliasRegistryId(id);
    return alias !== null && (registered.has(alias) || served.has(alias));
  };
  const collapsed = unregistered.filter(([id]) => foldsAway(id)).length;
  const missing = unregistered
    .filter(([id]) => !foldsAway(id))
    .map(([id, releasedAt]) => ({ id, releasedAt }))
    .sort((a, b) => (b.releasedAt ?? 0) - (a.releasedAt ?? 0));
  const shown = since === null ? missing : missing.filter((m) => (m.releasedAt ?? 0) >= since);
  const unserved = [...registered.keys()].filter((id) => !covered.has(id)).sort();

  console.log(`\nMissing from the registry (${shown.length}) — newest first:`);
  for (const model of shown) {
    console.log(`  ${formatDate(model.releasedAt)}  ${model.id}`);
  }
  if (shown.length < missing.length) {
    console.log(`  … ${missing.length - shown.length} more released before the --since cutoff`);
  }
  if (collapsed > 0) {
    console.log(`  … ${collapsed} dated snapshots folded into the aliases above`);
  }

  // A channel that failed to answer serves an unknown set, so every registry id
  // it would have covered looks retired. Reporting that list would be worse than
  // reporting nothing: it invites deleting a model that is very much alive.
  if (anyChannelFailed) {
    console.log("\nNot served by any channel: skipped — a channel failed to answer.");
  } else {
    console.log(`\nNot served by any channel (${unserved.length}):`);
    for (const id of unserved) {
      console.log(`  ${id}${registered.get(id)?.hidden ? "  (hidden)" : ""}`);
    }
  }

  console.log(
    "\nIds only, and the registry is a curated selection — most of the above is catalog this app should not offer.",
  );
  console.log(
    "Pricing, context window, and capabilities come from the provider's docs — check them before adding an entry.",
  );

  // What `--strict` is allowed to fail on.
  //
  // Not `missing`: that is the provider's entire catalog minus this app's
  // curated selection — embeddings, realtime, moderation, internal codenames —
  // so gating on it is an exit code that can never be green, which is the same
  // as no gate at all. A registered model no channel serves is real drift and
  // always counts. Newly released models count only once `--since` has narrowed
  // them to a set someone meant to look at.
  //
  // A channel that never answered means the check did not run, which must not
  // read as "all clear" to whatever is gating on the exit code.
  const gated = unserved.length + (since === null ? 0 : shown.length);
  if (strict && (anyChannelFailed || gated > 0)) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("CHECK FAILED:", error);
  process.exit(1);
});
