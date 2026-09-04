/**
 * Diff the model registry against the models the configured LLM channels serve.
 *
 * The registry is the catalog agent-models publishes, as this checkout's
 * snapshot holds it (`src/domain/llm/catalog.json`; `pnpm sync-models`
 * refreshes it). agent-models watches the providers' public catalogs itself;
 * what it cannot see is *this deployment's* channels — a gateway under
 * `LLM_BASE_URL`, a Bedrock route, a key that only reaches some models — and
 * that is what this script compares against. It reports the two lists and
 * leaves every judgement to a human:
 *
 *   - served by a channel, absent from the registry  → candidate to add
 *   - in the registry, served by no channel          → candidate to retire
 *
 *   pnpm check-models                    # report; always exits 0
 *   pnpm check-models --since=90d        # only models released in the last 90 days
 *   pnpm check-models --since=2026-01-01 # ...or since a date
 *   pnpm check-models --strict           # exit 1 on an offered route nothing serves,
 *                                        #   or on a check that could not run
 *
 * The registry is a *curated* selection, not a mirror: a provider channel serves
 * its entire catalog — speech, moderation, fine-tunes, every dated
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
import {
  listModels,
  loadSelfHostedModels,
  SELF_HOSTED_PROVIDERS,
  SUPPORTED_PROVIDERS,
} from "@/domain/llm/models";
import { AWS_SIGNING_SERVICE, createSignedFetch } from "@/infrastructure/llm/awsSigner";
import type { ChannelAuth, ProviderChannelConfig } from "@/domain/settings/types";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Anthropic requires an explicit API version on every request. */
const ANTHROPIC_VERSION = "2023-06-01";

export interface Channel {
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
  /**
   * Other ids the channel answers to for this model, in registry id form.
   * xAI lists only canonical ids and puts every accepted spelling here, so
   * `grok-4.20` — a live alias of `grok-4.20-0309-reasoning` — appears nowhere
   * else in the catalog. Empty for a channel that declares none.
   */
  aliases: string[];
}

/**
 * Effective channel configuration. Runtime settings own the DB-override →
 * env-fallback precedence, so this asks them rather than reading the env
 * itself; when the settings row is unreachable (no database running on this
 * machine) it degrades to the env channels instead of
 * refusing to run — a report from the env channels is still useful.
 */
async function resolveChannels(): Promise<Channel[]> {
  const { config } = await import("@/lib/config");
  let runtimeSettings: typeof import("@/lib/runtime-settings") | undefined;
  let base: { baseUrl: string; apiKey: string };
  let providers: ProviderChannelConfig[];
  try {
    const settings = await import("@/lib/runtime-settings");
    base = await settings.getLlmChannelConfig();
    providers = await settings.getLlmProviderConfigs();
    // The second publisher's models, or every declared self-hosted model reads
    // as "missing from the registry" — an invitation to add it to agent-models,
    // the one publisher it must not come from.
    loadSelfHostedModels(await settings.getSelfHostedModels());
    runtimeSettings = settings;
  } catch (error) {
    console.warn(
      `! stored settings unreachable (${error instanceof Error ? error.message : String(error)}); using environment channels only\n`,
    );
    const { parseProviderConfigs } = await import("@/infrastructure/llm/providers");
    base = { baseUrl: config.llmBaseUrl, apiKey: config.llmApiKey };
    providers = parseProviderConfigs(process.env);
  }

  const channels: Channel[] = [
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
  if (config.embeddingProvider === "openai" && config.embeddingBaseUrl) {
    const model = runtimeSettings
      ? await runtimeSettings.getEmbeddingModel()
      : config.embeddingModel;
    channels.push({
      label: "embedding",
      baseUrl: config.embeddingBaseUrl,
      apiKey: config.embeddingApiKey ?? "not-required",
      provider: providerOf(model),
      keepModelPrefix: false,
      auth: "bearer",
    });
  }
  const reranker = config.reranker;
  if (reranker) {
    const model = runtimeSettings
      ? await runtimeSettings.getRerankerModel()
      : reranker.model;
    channels.push({
      label: "reranker",
      baseUrl: reranker.baseUrl,
      apiKey: reranker.apiKey ?? "",
      provider: providerOf(model),
      keepModelPrefix: false,
      auth: "bearer",
    });
  }
  return channels;
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
export function authHeaders(channel: Channel): Record<string, string> {
  if (channel.auth === "sigv4") {
    // The signer sets the header; anything put here would be overwritten by it.
    return {};
  }
  if (channel.apiKey === "") {
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

/**
 * The other spellings a channel accepts for this model, in registry id form.
 *
 * xAI's catalog is canonical ids only, with every accepted spelling in an
 * `aliases` array beside each one — `grok-4.20` is an alias of
 * `grok-4.20-0309-reasoning`, and `grok-code-fast-1` of `grok-build-0.1`. Both
 * are registered here and both dispatch fine, and both read as retired without
 * this: "candidate to retire" for two models that work, and a `--strict`
 * failure on a healthy registry. Unlike the dated-snapshot rule below this is
 * not a guess about a naming convention — the provider is stating it.
 */
function parseAliases(entry: Record<string, unknown>, channel: Channel): string[] {
  if (!Array.isArray(entry.aliases)) {
    return [];
  }
  return entry.aliases
    .filter((alias): alias is string => typeof alias === "string" && alias.length > 0)
    .map((alias) => qualify(alias, channel));
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
      collected.push({
        id: qualify(record.id, channel),
        releasedAt: parseReleasedAt(record),
        aliases: parseAliases(record, channel),
      });
    }
    if (body.has_more !== true || typeof body.last_id !== "string" || body.last_id === "") {
      const specialized = channel.provider === "openrouter"
        ? await Promise.all(
            (["image", "embeddings", "rerank", "transcription"] as const).map((modality) =>
              fetchSpecializedModels(channel, request, modality),
            ),
          )
        : [];
      return [...collected, ...specialized.flat()];
    }
    cursor = body.last_id;
  }
  throw new Error(`GET ${endpoint} → still paginating after ${MAX_PAGES} pages`);
}

/**
 * Models a channel keeps in a type-specific catalog.
 *
 * OpenRouter's Models API defaults to text output. Its `output_modalities`
 * filter is the authoritative discovery path for image, embedding, rerank and
 * transcription models; without these reads every specialized route appears
 * to be served by nothing, producing false retirement candidates and a
 * `--strict` failure on a healthy configuration.
 *
 * Called only for the dedicated OpenRouter channel. Other providers either
 * include their specialized models in `/models` or have their own explicitly
 * configured embedding/reranker channel in `resolveChannels`.
 */
async function fetchSpecializedModels(
  channel: Channel,
  request: typeof globalThis.fetch,
  modality: "image" | "embeddings" | "rerank" | "transcription",
): Promise<ServedModel[]> {
  const url = `${channel.baseUrl.replace(/\/+$/, "")}/models?output_modalities=${modality}`;
  const response = await request(url, { headers: authHeaders(channel) });
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
    collected.push({
      id: qualify(record.id, channel),
      releasedAt: parseReleasedAt(record),
      aliases: parseAliases(record, channel),
    });
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
  listModels().filter((model) => model.wireId !== undefined).map((model) => [
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

/** The provider a registry id names, or the whole id when it names none. */
function providerOf(id: string): string {
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(0, slash) : id;
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
  const declaredAliases = new Set<string>();
  let anyChannelFailed = false;
  for (const channel of channels) {
    try {
      const models = await fetchModels(channel);
      const selectable = models.filter((model) => isSelectable(model.id));
      for (const model of selectable) {
        for (const alias of model.aliases) {
          if (isSelectable(alias)) {
            declaredAliases.add(alias);
          }
        }
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

  // Every channel answered and not one of them served an id this report can
  // compare against the registry. That is a configuration, not a catalog: the
  // default channel may be a provider's own endpoint rather than a router — this
  // deployment's is — and then it serves bare ids, which are ignored by design.
  // With no provider channel beside it there is nothing left to compare, and the
  // registry reads as retired in its entirety. Which is the worst false positive
  // available here, in the one list that invites deleting a live model.
  const nothingComparable = !anyChannelFailed && served.size === 0;

  const registered = new Map(listModels().map((model) => [model.id, model]));

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
  // The aliases a channel declares are credited the same way, and for the same
  // reason: they satisfy a registry entry without ever counting as a model
  // observed in its own right.
  for (const alias of declaredAliases) {
    covered.add(alias);
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

  /**
   * A registry route whose provider has no channel was never asked about.
   *
   * `google/*` is registered here and no deployment of this app configures
   * `LLM_PROVIDER_GOOGLE_*`, so those ids fall through to the default channel
   * and are answered by whatever that is. Nothing observed them, which is not
   * the same as a provider retiring them — and the difference matters, because
   * one is a finding and the other is a question about configuration. With no
   * provider channel at all the default channel takes every id, so every
   * provider is asked and this exclusion is empty.
   */
  const asked = new Set(channels.map((channel) => channel.provider).filter((p) => p !== null));
  const unasked = asked.size === 0 ? [] : unserved.filter((id) => !asked.has(providerOf(id)));
  const retired = unserved.filter((id) => asked.size === 0 || asked.has(providerOf(id)));

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
  } else if (nothingComparable) {
    console.log(
      "\nNot served by any channel: skipped — no channel served an id in `provider/model` form, so there was nothing to compare.",
    );
  } else {
    console.log(`\nNot served by any channel (${retired.length}):`);
    for (const id of retired) {
      console.log(`  ${id}${registered.get(id)?.hidden ? "  (hidden)" : ""}`);
    }
    if (unasked.length > 0) {
      console.log(`\nNo channel configured for their provider — not checked (${unasked.length}):`);
      for (const id of unasked) {
        console.log(`  ${id}${registered.get(id)?.hidden ? "  (hidden)" : ""}`);
      }
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
  // curated selection — realtime, moderation, internal codenames —
  // so gating on it is an exit code that can never be green, which is the same
  // as no gate at all. `--since` narrows that list for a reader without changing
  // what it is: a router channel keeps shipping, and OpenRouter alone listed five
  // new ids in the last seven days, not one of them something this app would
  // offer. So the narrowed form reports too, and does not gate.
  //
  // What does count is an *offered* route disappearing from a provider this
  // deployment actually asks. Two exclusions, both for the same reason — the
  // answer is already known, so it is not news:
  //
  //   - a provider with no channel was never asked (`unasked` above);
  //   - a `hidden` route is one this app already retired. `models.ts` keeps
  //     those entries deliberately and forever — a past run's usage row is
  //     priced by looking the model up there, so deleting one re-prices history
  //     at $0 — which makes "hidden and no longer served" the documented end
  //     state of a retirement rather than a finding. Gating on it is another
  //     exit code that can never be green;
  //   - a self-hosted route is one catalog entry serving every deployment's
  //     own endpoint, so "not served by this deployment's server" is the
  //     expected state whenever another deployment carries the family — a
  //     report line for a human, not drift.
  //
  // And a check that could not run — a channel that never answered, or every
  // channel answering with nothing comparable — counts, because "did not run"
  // must not read as "all clear" to whatever is gating on the exit code.
  const drifted = retired.filter(
    (id) =>
      registered.get(id)?.hidden !== true &&
      !(SELF_HOSTED_PROVIDERS as readonly string[]).includes(providerOf(id)),
  );
  if (strict && (anyChannelFailed || nothingComparable || drifted.length > 0)) {
    process.exit(1);
  }
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  main().catch((error) => {
    console.error("CHECK FAILED:", error);
    process.exit(1);
  });
}
