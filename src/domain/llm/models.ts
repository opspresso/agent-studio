/**
 * Model registry: per-model pricing and capability flags. Model ids use the
 * OpenAI-compatible `provider/model` form that the LLM channel dispatches on.
 *
 * **The numbers are not in this repository.** The registry is maintained in
 * [opspresso/agent-models](https://github.com/opspresso/agent-models) — one
 * family per model, one offering per route, refreshed from the providers every
 * day — and published as `https://models.opspresso.com/models.json`. This
 * module *loads* that catalog and answers questions about it; it does not
 * state a price. Adding a model, retiring one, or correcting a rate is done
 * there, never here.
 *
 * Two copies of the catalog reach this process. `./catalog.json` is a
 * committed snapshot, loaded at module evaluation: it is what the unit tests
 * run against, what `next build` sees, and what a boot falls back to when the
 * published catalog cannot be fetched (`pnpm sync-models` refreshes it). The
 * published catalog is fetched at boot and on an interval
 * (`application/llm/modelCatalogRefresh.ts`) and replaces the snapshot
 * wholesale through `loadModelCatalog`, which is the one way in: it validates
 * each entry against the shape below, drops what does not fit, and swaps the
 * registry atomically. Lookups are by id at the moment of use — a long run
 * whose model leaves the catalog mid-flight books its later usage at $0
 * through the unknown-model path below — which is tolerable because
 * agent-models retires by hiding, never by deleting: an id vanishing outright
 * is a publisher defect, and `parseCatalog`'s shrink guard refuses the
 * catalogs where that happens wholesale, reporting the rest.
 *
 * The catalog's shape is this module's `ModelConfig`, because agent-models
 * writes it for this reader; a field is added there only when this file can
 * read it.
 *
 * **Self-hosted models have a second publisher: the deployment itself.**
 * agent-models states global facts — a vendor's price is true everywhere —
 * but which models a `selfhosted` channel serves is a fact about one
 * deployment's own hardware, so those entries come from the deployment's
 * declarations (runtime settings) through `loadSelfHostedModels`, into an
 * overlay a catalog refresh never touches. Same `ModelConfig`, same
 * validation; only the publisher differs.
 */

import type { ChannelParams } from "./channel";
import snapshot from "./catalog.json";

/**
 * Providers selectable for per-provider LLM channels; model ids are prefixed by
 * these. Code, not catalog: a provider is a *channel* this app knows how to
 * authenticate to and dispatch through (`resolveProviderTarget`), so a catalog
 * entry under a prefix not listed here is skipped on load rather than offered
 * to a channel that does not exist.
 *
 * `bedrock` and `openrouter` are routes rather than model vendors — the same
 * family is reachable through them and through its vendor's own API.
 *
 * `selfhosted` is a route too, one the deployment operates itself: an
 * OpenAI-compatible server the operator runs — LM Studio on a laptop, vLLM on
 * a server. The prefix is the same everywhere; where it dispatches is each
 * deployment's `LLM_PROVIDER_SELFHOSTED_BASE_URL`. The serving stack must name
 * the model as the id's family (vLLM `--served-model-name`, LM Studio's model
 * identifier), which is what lets one catalog entry serve every deployment
 * without a `wireId`.
 */
export const SUPPORTED_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "xai",
  "bedrock",
  "openrouter",
  "selfhosted",
] as const;
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

/**
 * Providers whose channel the deployment operates itself rather than buys from
 * a vendor. What membership changes: zero is such a model's *true* price, so
 * the priced-text-model guard in `rejectReason` exempts these — explicitly
 * stated zero only; absent prices still fail. Code, not catalog, for the same
 * reason as `SUPPORTED_PROVIDERS`: whether a channel bills is a property of
 * the channel, and the channels are this app's.
 */
export const SELF_HOSTED_PROVIDERS = ["selfhosted"] as const satisfies readonly SupportedProvider[];

/**
 * Single-rate by design — one number per token class, the base (sub-threshold,
 * standard-tier) rate. Providers that publish a second, higher tier past a
 * token threshold are under-counted here; supporting tiers means widening this
 * type and `calculateCost` together, not patching a number.
 */
export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  cachedInputPer1M?: number;
  /** Image-token rates for image-generation models. */
  imageInputPer1M?: number;
  imageOutputPer1M?: number;
  /**
   * Flat per-image price. Authoritative for models with no token-based image
   * output rate (`imageOutputPer1M` absent/0); informational otherwise.
   */
  perImage?: number;
  /** Flat charge for each source image supplied to an image edit. */
  perInputImage?: number;
  /**
   * A promotional discount, as a fraction in (0, 1), that the rates above are
   * already net of — informational: cost is computed from the rates as stated.
   * Present only where the registry's source publishes one (OpenRouter).
   */
  discount?: number;
}

export interface ModelCapabilities {
  tools: boolean;
  structuredOutput: boolean;
  imageInput: boolean;
  reasoning: boolean;
  imageGeneration?: boolean;
  /** Produces vectors through an embeddings endpoint rather than generated tokens. */
  embedding?: boolean;
  /**
   * False when the provider rejects `tools` together with `reasoning_effort`
   * on chat/completions (the provider's remedy is an explicit effort of
   * "none"). Absent means the combination is allowed.
   */
  reasoningWithTools?: boolean;
}

export type ModelType = "text" | "image" | "embedding";

export interface ModelConfig {
  /** `provider/family`, e.g. `google/gemini-3.1-flash-lite`. */
  id: string;
  provider: string;
  /** The family this offering serves — the id's part after the prefix. */
  family: string;
  /** The company that made the model, independent of the route serving it. */
  maker: string;
  displayName: string;
  pricing: ModelPricing;
  capabilities: ModelCapabilities;
  contextWindow: number;
  maxTokens: number;
  /** Hidden from the public model list but still usable. */
  hidden?: boolean;
  /**
   * Model name to send when the `provider/` prefix is stripped for a
   * provider-direct channel, for the routes whose provider names the model
   * differently from this registry (`anthropic/claude-opus-4.8` is
   * `claude-opus-4-8` to Anthropic; OpenRouter takes `anthropic/claude-opus-4.8`).
   * Omitted when the bare id already matches.
   */
  wireId?: string;
}

export const MODEL_CATALOG_VERSION = 1;
/** Bounds the deployment-wide denylist stored in the single settings row. */
export const MAX_HIDDEN_MODELS = 500;

/** What a load did: how many entries were installed, which were dropped and why. */
export interface ModelCatalogLoadReport {
  loaded: number;
  /** `id — reason`, one per entry the catalog carried and this registry refused. */
  skipped: string[];
  /**
   * Ids the registry held before this load and the new catalog no longer
   * carries. agent-models retires by hiding, so anything here is worth a
   * warning: a stored version naming one of these now books usage at $0.
   */
  removed: string[];
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// The registry state, and the one way in
// ---------------------------------------------------------------------------

interface RegistryState {
  models: ModelConfig[];
  byId: Map<string, ModelConfig>;
  makers: Record<string, string>;
  updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

const PRICING_RATE_KEYS = [
  "inputPer1M",
  "outputPer1M",
  "cachedInputPer1M",
  "imageInputPer1M",
  "imageOutputPer1M",
  "perImage",
  "perInputImage",
] as const;
const CAPABILITY_KEYS = ["tools", "structuredOutput", "imageInput", "reasoning"] as const;
const OPTIONAL_CAPABILITY_KEYS = ["imageGeneration", "embedding", "reasoningWithTools"] as const;

/**
 * Why a catalog entry cannot be installed, or null when it can. Strict on the
 * fields a run reads (a price that is not a number books a call at NaN; a
 * window that is not a count breaks the context budget) and silent on the
 * rest, so a field the catalog gains later does not take every model with it.
 */
function rejectReason(entry: unknown): string | null {
  if (!isRecord(entry)) return "not an object";
  const id = entry.id;
  if (typeof id !== "string" || id === "") return "no id";
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) return "id is not provider/family";
  const provider = id.slice(0, slash);
  if (!(SUPPORTED_PROVIDERS as readonly string[]).includes(provider)) {
    return `provider "${provider}" is not a channel this app has`;
  }
  if (entry.provider !== provider) return "provider field disagrees with the id";
  if (entry.family !== id.slice(slash + 1)) return "family field disagrees with the id";
  if (typeof entry.maker !== "string" || entry.maker === "") return "no maker";
  if (typeof entry.displayName !== "string" || entry.displayName.trim() === "") return "no displayName";
  if (!isRecord(entry.pricing)) return "no pricing";
  if (!isRate(entry.pricing.inputPer1M) || !isRate(entry.pricing.outputPer1M)) {
    return "pricing lacks inputPer1M/outputPer1M";
  }
  for (const key of PRICING_RATE_KEYS) {
    const value = entry.pricing[key];
    if (value !== undefined && !isRate(value)) return `pricing.${key} is not a rate`;
  }
  if (entry.pricing.discount !== undefined) {
    const d = entry.pricing.discount;
    if (typeof d !== "number" || !(d > 0 && d < 1)) return "pricing.discount is not a fraction";
  }
  if (
    entry.pricing.cachedInputPer1M !== undefined &&
    (entry.pricing.cachedInputPer1M as number) > (entry.pricing.inputPer1M as number)
  ) {
    // `calculateCost` bills cached tokens at this rate believing it a discount.
    return "cached input priced above uncached";
  }
  if (!isRecord(entry.capabilities)) return "no capabilities";
  for (const key of CAPABILITY_KEYS) {
    if (typeof entry.capabilities[key] !== "boolean") return `capabilities.${key} is not a boolean`;
  }
  for (const key of OPTIONAL_CAPABILITY_KEYS) {
    const value = entry.capabilities[key];
    if (value !== undefined && typeof value !== "boolean") return `capabilities.${key} is not a boolean`;
  }
  const imageGeneration = entry.capabilities.imageGeneration === true;
  const embedding = entry.capabilities.embedding === true;
  if (imageGeneration && embedding) {
    return "a model may not be both imageGeneration and embedding";
  }
  if (embedding) {
    if (!((entry.pricing.inputPer1M as number) > 0) || entry.pricing.outputPer1M !== 0) {
      return "an embedding model needs an input price above zero and an output price of zero";
    }
  } else if (!imageGeneration) {
    // An unpriced text model is worse than a missing one: the lookup succeeds
    // and every call books at $0 with no warning. Self-hosted channels are the
    // deliberate exception — zero is their true price, and it is stated, not
    // missing: absent prices already failed the pricing check above.
    if (
      !(SELF_HOSTED_PROVIDERS as readonly string[]).includes(provider) &&
      (!((entry.pricing.inputPer1M as number) > 0) || !((entry.pricing.outputPer1M as number) > 0))
    ) {
      return "a text model needs input and output prices above zero";
    }
  } else if (
    !(((entry.pricing.imageOutputPer1M as number | undefined) ?? 0) > 0) &&
    !(((entry.pricing.perImage as number | undefined) ?? 0) > 0)
  ) {
    return "an image model needs imageOutputPer1M or perImage";
  }
  if (!isCount(entry.contextWindow) && !(imageGeneration && entry.contextWindow === 0)) {
    return "contextWindow is not a positive integer or zero for an image model";
  }
  if (
    embedding
      ? entry.maxTokens !== 0
      : !isCount(entry.maxTokens) && !(imageGeneration && entry.maxTokens === 0)
  ) {
    return "maxTokens must be zero for an embedding model, otherwise a positive integer or zero for an image model";
  }
  if ((entry.maxTokens as number) > (entry.contextWindow as number)) {
    return "maxTokens exceeds contextWindow";
  }
  // An explicit false means what absence means; only a non-boolean is malformed.
  if (entry.hidden !== undefined && typeof entry.hidden !== "boolean") return "hidden is not a boolean";
  if (entry.wireId !== undefined && (typeof entry.wireId !== "string" || entry.wireId === "")) {
    return "wireId is not a string";
  }
  // A router names models `vendor/model`; without the vendor in the wire id,
  // dispatch sends the bare id and OpenRouter 404s a model it serves.
  if (provider === "openrouter" && (typeof entry.wireId !== "string" || !entry.wireId.includes("/"))) {
    return "an openrouter entry needs a vendor-qualified wireId";
  }
  // Anthropic serves hyphenated names and 404s the dotted form the registry
  // uses, so a dotted `anthropic/` id is dispatchable only through its wireId.
  if (provider === "anthropic" && (entry.family as string).includes(".")) {
    const expected = (entry.family as string).replaceAll(".", "-");
    if (entry.wireId !== expected) {
      return `a dotted Anthropic id needs wireId "${expected}"`;
    }
  }
  // A selfhosted family is served under its own name by every deployment's
  // stack — the convention that lets one entry serve them all — so a wireId
  // here would rename the model globally for endpoints this catalog has never
  // seen. Refused rather than ignored, because the publisher meant something
  // by it and half-applying it would be worse.
  if ((SELF_HOSTED_PROVIDERS as readonly string[]).includes(provider) && entry.wireId !== undefined) {
    return "a selfhosted entry must not carry a wireId — the family is the served name";
  }
  return null;
}

/** The entry as this module will hold it — the known fields, nothing the catalog may have added. */
function toModelConfig(entry: Record<string, unknown>): ModelConfig {
  const pricing = entry.pricing as Record<string, unknown>;
  const capabilities = entry.capabilities as Record<string, unknown>;
  const picked = <T extends string>(source: Record<string, unknown>, keys: readonly T[]) =>
    Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
  return {
    id: entry.id as string,
    provider: entry.provider as string,
    family: entry.family as string,
    maker: entry.maker as string,
    displayName: entry.displayName as string,
    pricing: picked(pricing, [...PRICING_RATE_KEYS, "discount"]) as unknown as ModelPricing,
    capabilities: picked(capabilities, [...CAPABILITY_KEYS, ...OPTIONAL_CAPABILITY_KEYS]) as unknown as ModelCapabilities,
    contextWindow: entry.contextWindow as number,
    maxTokens: entry.maxTokens as number,
    ...(entry.wireId !== undefined ? { wireId: entry.wireId as string } : {}),
    ...(entry.hidden === true ? { hidden: true } : {}),
  };
}

/**
 * Validate a catalog into registry state, without installing it. Throws when
 * the catalog as a whole is unusable — wrong version, no models, or nothing
 * that survives validation — because replacing a working registry with an
 * empty one is the one outcome worse than a stale one.
 */
function parseCatalog(catalog: unknown): { state: RegistryState; report: ModelCatalogLoadReport } {
  if (!isRecord(catalog)) throw new Error("model catalog is not an object");
  if (catalog.version !== MODEL_CATALOG_VERSION) {
    throw new Error(`model catalog version ${String(catalog.version)} is not ${MODEL_CATALOG_VERSION}`);
  }
  if (!Array.isArray(catalog.models) || catalog.models.length === 0) {
    throw new Error("model catalog carries no models");
  }
  const makers: Record<string, string> = {};
  if (isRecord(catalog.makers)) {
    for (const [maker, label] of Object.entries(catalog.makers)) {
      if (typeof label === "string" && label !== "") makers[maker] = label;
    }
  }
  const models: ModelConfig[] = [];
  const byId = new Map<string, ModelConfig>();
  const skipped: string[] = [];
  for (const entry of catalog.models) {
    const reason = rejectReason(entry);
    const id = isRecord(entry) && typeof entry.id === "string" ? entry.id : "(no id)";
    if (reason !== null) {
      skipped.push(`${id} — ${reason}`);
      continue;
    }
    if (byId.has(id)) {
      skipped.push(`${id} — duplicate id`);
      continue;
    }
    const model = toModelConfig(entry as Record<string, unknown>);
    models.push(model);
    byId.set(model.id, model);
  }
  // The same model reached two ways is one model: routes to a family must
  // agree on what it is, or dispatch, budgets and the picker each tell a
  // different story about one name. The first route in wins; disagreeing
  // later ones are dropped, named, and the catalog's publisher hears of it.
  const familyShape = new Map<string, ModelConfig>();
  const consistent = models.filter((model) => {
    const first = familyShape.get(model.family);
    if (first === undefined) {
      familyShape.set(model.family, model);
      return true;
    }
    const disagrees =
      first.displayName !== model.displayName ||
      first.maker !== model.maker ||
      first.contextWindow !== model.contextWindow ||
      (first.capabilities.imageGeneration ?? false) !== (model.capabilities.imageGeneration ?? false) ||
      (first.capabilities.embedding ?? false) !== (model.capabilities.embedding ?? false);
    if (disagrees) {
      skipped.push(`${model.id} — disagrees with ${first.id} about what ${model.family} is`);
      byId.delete(model.id);
      return false;
    }
    return true;
  });
  if (consistent.length === 0) {
    throw new Error(`model catalog carries ${catalog.models.length} models and none is usable`);
  }
  const updatedAt = typeof catalog.updatedAt === "string" ? catalog.updatedAt : "";
  return {
    state: { models: consistent, byId, makers, updatedAt },
    report: { loaded: consistent.length, skipped, removed: [], updatedAt },
  };
}

/**
 * The registry lives on `globalThis`, not in a module-scoped `let`: in dev,
 * editing a server file re-evaluates this module, and a plain `let` would
 * reset routes to the snapshot while the boot-time refresher keeps feeding the
 * *old* module instance — the split-brain `recordAudit` documents for the
 * audit sink. One process, one registry, however many times the module loads.
 * The snapshot parse also proves the fallback loads; a broken snapshot fails
 * the first import (and so the build), not the first request.
 */
const REGISTRY_SLOT = Symbol.for("agent-studio.model-registry");
const slot = globalThis as { [REGISTRY_SLOT]?: RegistryState };
slot[REGISTRY_SLOT] ??= parseCatalog(snapshot).state;

function registryState(): RegistryState {
  return slot[REGISTRY_SLOT] as RegistryState;
}

// ---------------------------------------------------------------------------
// The self-hosted overlay, and its own way in
// ---------------------------------------------------------------------------

/** What the deployment's declarations install: a second, smaller registry. */
interface LocalState {
  models: ModelConfig[];
  byId: Map<string, ModelConfig>;
}

const LOCAL_SLOT = Symbol.for("agent-studio.self-hosted-models");
const localSlot = globalThis as { [LOCAL_SLOT]?: LocalState };

function localState(): LocalState {
  return (localSlot[LOCAL_SLOT] ??= { models: [], byId: new Map() });
}

/**
 * Why a self-hosted declaration cannot be installed, or null when it can.
 *
 * A declaration passes the same `rejectReason` every catalog entry does — one
 * validation, whoever the publisher is — plus what being the *second*
 * publisher adds: only self-hosted routes may come from here, an id the
 * published catalog already carries is the catalog's to define, and a family
 * the catalog also serves must be the same model — the one-story-per-family
 * rule, held across publishers.
 */
export function selfHostedModelRejectReason(entry: unknown): string | null {
  const reason = rejectReason(entry);
  if (reason !== null) {
    return reason;
  }
  const model = entry as Record<string, unknown>;
  if (!(SELF_HOSTED_PROVIDERS as readonly string[]).includes(model.provider as string)) {
    return `a declaration may only add a self-hosted route, not "${String(model.provider)}"`;
  }
  const catalog = registryState();
  if (catalog.byId.has(model.id as string)) {
    return "the published catalog already carries this id";
  }
  const family = model.family as string;
  const first = catalog.models.find((m) => m.family === family);
  if (first !== undefined) {
    const declared = toModelConfig(model);
    const disagrees =
      first.displayName !== declared.displayName ||
      first.maker !== declared.maker ||
      first.contextWindow !== declared.contextWindow ||
      (first.capabilities.imageGeneration ?? false) !==
        (declared.capabilities.imageGeneration ?? false) ||
      (first.capabilities.embedding ?? false) !== (declared.capabilities.embedding ?? false);
    if (disagrees) {
      return `disagrees with ${first.id} about what ${family} is`;
    }
  }
  return null;
}

/**
 * Install the deployment's self-hosted declarations, replacing the overlay
 * wholesale — the second way into the registry, for the second publisher.
 * The declaration's shape and its form mappings live in
 * `./selfHostedModels.ts`, since a declaration constructor must state the one
 * number this module may not: the zero price.
 *
 * The overlay survives `loadModelCatalog` on purpose: a catalog refresh
 * replaces what agent-models publishes and nothing else. Validation reads the
 * *current* catalog, so it re-runs on every install — the refresher installs
 * the overlay right after each catalog tick, which is what resolves a conflict
 * a newer catalog introduces (the losing declaration is dropped and named).
 * Unlike the catalog there is no shrink guard and an empty list installs:
 * deleting every declaration is an ordinary thing for an operator to mean.
 */
export function loadSelfHostedModels(entries: unknown): ModelCatalogLoadReport {
  if (!Array.isArray(entries)) {
    throw new Error("self-hosted declarations are not an array");
  }
  const models: ModelConfig[] = [];
  const byId = new Map<string, ModelConfig>();
  const skipped: string[] = [];
  for (const entry of entries) {
    const id = isRecord(entry) && typeof entry.id === "string" ? entry.id : "(no id)";
    const reason = selfHostedModelRejectReason(entry);
    if (reason !== null) {
      skipped.push(`${id} — ${reason}`);
      continue;
    }
    if (byId.has(id)) {
      skipped.push(`${id} — duplicate id`);
      continue;
    }
    const model = toModelConfig(entry as Record<string, unknown>);
    models.push(model);
    byId.set(model.id, model);
  }
  const previous = localState();
  const removed = previous.models.filter((m) => !byId.has(m.id)).map((m) => m.id);
  localSlot[LOCAL_SLOT] = { models, byId };
  return { loaded: models.length, skipped, removed, updatedAt: "" };
}

/**
 * Install a catalog. Atomic: the registry is the old state or the new one,
 * never between. Throws, leaving the old state in place, when the catalog is
 * unusable (see `parseCatalog`) — or when it would silently orphan most of
 * the registry: agent-models retires by hiding, never by deleting, so a
 * catalog missing more than half of the ids currently held is a truncated
 * publish, not a decision. Smaller disappearances install and are reported
 * as `removed`, for the caller to warn about.
 */
export function loadModelCatalog(
  catalog: unknown,
  options?: {
    /**
     * How much of the current registry a catalog may drop before it is read
     * as truncated, as a fraction. Defaults to half; `1` disables the guard —
     * a test seam, since a unit test installs registries nothing published.
     */
    maxDropFraction?: number;
  },
): ModelCatalogLoadReport {
  const parsed = parseCatalog(catalog);
  const current = registryState();
  const removed = current.models.filter((m) => !parsed.state.byId.has(m.id)).map((m) => m.id);
  const maxDrop = options?.maxDropFraction ?? 0.5;
  if (removed.length > current.models.length * maxDrop) {
    throw new Error(
      `model catalog drops ${removed.length} of ${current.models.length} current models — refusing a truncated catalog`,
    );
  }
  slot[REGISTRY_SLOT] = parsed.state;
  return { ...parsed.report, removed };
}

/** What a catalog document holds, read without installing it. */
export interface ModelCatalogSummary {
  /** Entries the registry would install. */
  models: number;
  /** `id — reason`, one per entry the registry would refuse. */
  skipped: string[];
  updatedAt: string;
}

/**
 * The same reading `loadModelCatalog` gives a document, without touching the
 * registry — what an upload is checked against before it is stored, so a
 * document that is not a catalog is refused at the door rather than at the
 * next refresh. Throws the loader's own reason for one that cannot be loaded.
 */
export function validateModelCatalog(catalog: unknown): ModelCatalogSummary {
  const { report } = parseCatalog(catalog);
  return { models: report.loaded, skipped: report.skipped, updatedAt: report.updatedAt };
}

/**
 * Every model the registry currently holds, hidden ones included, in catalog
 * order — which agent-models states deliberately (providers in its
 * `providers.json` order, then each file's order), so "the first entry that
 * can draw" and its kin are decisions the publisher curates, not accidents.
 * The deployment's self-hosted declarations follow, in declaration order.
 */
export function listModels(): ModelConfig[] {
  return [...registryState().models, ...localState().models];
}

/** When the loaded catalog's content last changed — shown by the Models console. */
export function modelCatalogUpdatedAt(): string {
  return registryState().updatedAt;
}

/**
 * Maker id → display label, for every maker the loaded catalog names. A maker
 * only a declaration names is labeled with its own id — a declaration carries
 * no label, and a maker every reader can name is the invariant, not the prose.
 */
export function listModelMakers(): Record<string, string> {
  const makers = { ...registryState().makers };
  for (const model of localState().models) {
    makers[model.maker] ??= model.maker;
  }
  return makers;
}

export function getModelConfig(id: string): ModelConfig | undefined {
  return registryState().byId.get(id) ?? localState().byId.get(id);
}

/**
 * Ids the deployment's declarations currently install — what tells the second
 * publisher's models from the catalog's. The console needs the difference:
 * only declarations are its to edit, and a full-replace save that swept a
 * catalog-published selfhosted entry in would refuse itself against the
 * "catalog already carries this id" rule.
 */
export function selfHostedDeclarationIds(): string[] {
  return localState().models.map((model) => model.id);
}

export function getVisibleModels(): ModelConfig[] {
  return listModels().filter((m) => !m.hidden);
}

/** The catalog's three mutually exclusive model types, derived from capability flags. */
export function modelType(model: Pick<ModelConfig, "capabilities">): ModelType {
  if (model.capabilities.embedding === true) return "embedding";
  if (model.capabilities.imageGeneration === true) return "image";
  return "text";
}

/** Token counts as a reader compares them: 1,048,576 → `1.05M`, 131,072 → `131K`. */
function roundTokens(tokens: number): string {
  // 999,500 up rounds to the M form, so nothing ever reads "1000K".
  if (tokens >= 999_500) {
    const millions = Math.round(tokens / 10_000) / 100;
    return `${millions}M`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}K`;
  }
  return `${tokens}`;
}

/**
 * How much a model can be told, and how much of that the answer may take.
 *
 * The two travel together because the output cap is spent *out of* the window —
 * `createRunContextBudget` subtracts one from the other to size the prompt — so
 * a window alone overstates the room a long chat has. Rounded on purpose: the
 * exact figure is never what a choice turns on, and 1,048,576 against 1,050,000
 * is the same decision twice.
 *
 * Here rather than beside the price label it is drawn next to, because reading
 * `contextWindow` outside this file is what a second context-budget derivation
 * starts with — `tests/architecture.test.ts` keeps that read single, and a
 * model's own numbers are the registry's vocabulary anyway.
 */
export function contextWindowLabel(
  model: Pick<ModelConfig, "contextWindow" | "maxTokens"> &
    Partial<Pick<ModelConfig, "capabilities">>,
): string {
  if (model.capabilities?.embedding === true) {
    return `Context ${roundTokens(model.contextWindow)}`;
  }
  return `Context ${roundTokens(model.contextWindow)} · max out ${roundTokens(model.maxTokens)}`;
}

/**
 * Whether a deployment can offer a provider's models: through its dedicated
 * channel once any channel is configured, else through the default channel —
 * which serves every prefix *except* the self-hosted ones. A `selfhosted/` id
 * names an endpoint only its own channel knows; no router behind the default
 * channel serves that prefix, so offering it without the channel is offering
 * a guaranteed 404. One owner because the /models console's availability
 * column and the pickers below must tell one story.
 */
export function providerOffered(name: string, dedicated: ReadonlySet<string>): boolean {
  if (dedicated.size > 0) {
    return dedicated.has(name);
  }
  return !(SELF_HOSTED_PROVIDERS as readonly string[]).includes(name);
}

/**
 * The models this deployment offers for selection: visible entries, narrowed
 * by the configured provider channels (none configured = the default channel
 * dispatches every id — self-hosted providers excepted, see `providerOffered`),
 * then by the hidden-model denylist (absent = no restriction; a stale id
 * simply matches nothing). One owner because the /api/models list and the
 * model a fresh project's initial version starts with must answer identically.
 */
export function offeredModels(
  providerNames: string[],
  hiddenIds: string[] | undefined,
): ModelConfig[] {
  const providers = new Set(providerNames);
  const hidden = new Set(hiddenIds ?? []);
  return getVisibleModels().filter(
    (model) =>
      modelType(model) !== "embedding" &&
      providerOffered(model.provider, providers) &&
      !hidden.has(model.id),
  );
}

/**
 * The model name to send to a provider's own API, for a `provider/model` id
 * whose prefix is being stripped for a provider-direct channel. Defaults to the
 * bare id, which is also what an id missing from the registry gets — a model
 * this app does not know is passed through rather than rewritten.
 */
export function wireModelId(modelId: string): string {
  const slash = modelId.indexOf("/");
  const bare = slash > 0 ? modelId.slice(slash + 1) : modelId;
  return getModelConfig(modelId)?.wireId ?? bare;
}

/** Tokens observed on a single call, used for cost calculation. */
export interface CostTokens {
  inputTokens: number;
  outputTokens: number;
  /** Cached prompt tokens billed at the cached rate when the model has one. */
  cachedTokens?: number;
}

/**
 * Why a model cannot accept image input, or `null` when it can. A model missing
 * from the registry is rejected: sending images to an unknown model fails at
 * the provider with a far less legible error.
 */
export function describeImageInputReject(modelId: string): string | null {
  const cfg = getModelConfig(modelId);
  if (!cfg) {
    return `Model is not in the registry, so image input cannot be used: ${modelId}`;
  }
  return cfg.capabilities.imageInput
    ? null
    : `Model does not accept image input: ${modelId}`;
}

/**
 * Apply provider constraints the catalog knows about: models with
 * `reasoningWithTools: false` reject `tools` + `reasoning_effort` on
 * chat/completions, so the effort is forced to the provider's remedy, "none".
 */
export function applyModelConstraints(params: ChannelParams): ChannelParams {
  const cfg = getModelConfig(params.model);
  if (
    cfg?.capabilities.reasoningWithTools === false &&
    params.tools !== undefined &&
    params.tools.length > 0 &&
    params.reasoningEffort !== "none"
  ) {
    // The provider requires an EXPLICIT "none": omitting the field falls back
    // to a server-side reasoning default, which still rejects the tools.
    return { ...params, reasoningEffort: "none" };
  }
  return params;
}

// On `globalThis` for the registry's reason (see `REGISTRY_SLOT`): a dev
// re-evaluation of this module must not fork the counters `/api/metrics`
// reads away from the instance the engine is incrementing.
const UNKNOWN_MODEL_SLOT = Symbol.for("agent-studio.unknown-model-metrics");
const unknownSlot = globalThis as {
  [UNKNOWN_MODEL_SLOT]?: { warned: Set<string>; calls: number };
};
unknownSlot[UNKNOWN_MODEL_SLOT] ??= { warned: new Set<string>(), calls: 0 };
const unknownModels = unknownSlot[UNKNOWN_MODEL_SLOT];

/**
 * Record a model id missing from the catalog.
 *
 * Every occurrence is counted, because every one of them books that call's
 * usage at $0 — the count is the size of the under-reporting, not just a
 * curiosity. The log line is emitted once per id so a hot loop cannot flood
 * the log; the counter is what tells you the miss is still happening.
 */
function warnUnknownModel(modelId: string): void {
  unknownModels.calls += 1;
  if (unknownModels.warned.has(modelId)) {
    return;
  }
  unknownModels.warned.add(modelId);
  console.warn(`[cost] unknown model id "${modelId}": usage is recorded with $0 cost`);
}

export interface UnknownModelSnapshot {
  /** Cost calculations that fell back to $0 since process start. */
  calls: number;
  /** Distinct ids behind those calls. */
  models: number;
}

/**
 * Process-wide counts of registry misses, exposed by `/api/metrics`. Counts
 * only: that endpoint is unauthenticated and names no model, so the ids stay
 * in the log line above.
 */
export function unknownModelSnapshot(): UnknownModelSnapshot {
  return { calls: unknownModels.calls, models: unknownModels.warned.size };
}

/** Test seam — production code never resets counters. */
export function resetUnknownModelMetrics(): void {
  unknownModels.warned.clear();
  unknownModels.calls = 0;
}

/** Compute USD cost for one call from registry pricing. Unknown model → warn + 0. */
export function calculateCost(modelId: string, tokens: CostTokens): number {
  const cfg = getModelConfig(modelId);
  if (!cfg) {
    warnUnknownModel(modelId);
    return 0;
  }
  const { inputPer1M, outputPer1M, cachedInputPer1M } = cfg.pricing;
  const cached = tokens.cachedTokens ?? 0;
  const nonCachedInput = Math.max(0, tokens.inputTokens - cached);
  const cachedRate = cachedInputPer1M ?? inputPer1M;
  const inputCost = (nonCachedInput * inputPer1M + cached * cachedRate) / 1_000_000;
  const outputCost = (tokens.outputTokens * outputPer1M) / 1_000_000;
  return inputCost + outputCost;
}

/** Image-token usage of one image generation call. */
export interface ImageCostTokens {
  textInputTokens: number;
  imageInputTokens: number;
  imageOutputTokens: number;
  /** Source images supplied to an edit; needed by providers that bill each one flat. */
  sourceImages?: number;
}

/**
 * Compute USD cost for one image generation call (one image per call).
 * Models with no token-based image output rate are billed at their flat
 * `perImage` price. Unknown model → warn + 0.
 */
export function calculateImageCost(modelId: string, tokens: ImageCostTokens): number {
  const cfg = getModelConfig(modelId);
  if (!cfg) {
    warnUnknownModel(modelId);
    return 0;
  }
  const { inputPer1M, imageInputPer1M, imageOutputPer1M, perImage, perInputImage } = cfg.pricing;
  if (!imageOutputPer1M && perImage) {
    return perImage + (tokens.sourceImages ?? 0) * (perInputImage ?? 0);
  }
  return (
    (tokens.textInputTokens * inputPer1M +
      tokens.imageInputTokens * (imageInputPer1M ?? 0) +
      tokens.imageOutputTokens * (imageOutputPer1M ?? 0)) /
    1_000_000
  );
}

/**
 * An image result's usage in the shape usage records and trace spans both take.
 *
 * Image models bill three separate token counts; the usage row carries two. Four
 * call sites derived that collapse independently — this is the single owner of
 * it, next to the pricing it is paired with.
 */
export function toImageUsageRecord(
  modelId: string,
  tokens: ImageCostTokens,
): { inputTokens: number; outputTokens: number; costUsd: number } {
  return {
    inputTokens: tokens.textInputTokens + tokens.imageInputTokens,
    outputTokens: tokens.imageOutputTokens,
    costUsd: calculateImageCost(modelId, tokens),
  };
}
