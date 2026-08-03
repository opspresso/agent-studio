/**
 * Layer boundary enforcement.
 *
 * The dependency rule `app → application → domain ← infrastructure` lived only
 * in docs/ARCHITECTURE.md, so nothing stopped it from eroding. This test makes
 * it mechanical: no new dependency, just `node:fs` and a regex.
 *
 * Every rule's `allow` list is empty: the boundaries are enforced, not frozen.
 * A list is compared exactly (`toEqual` on a sorted array) rather than by count,
 * so one violation cannot disappear while another appears and read as unchanged.
 * A boundary that ever has to be relaxed belongs in `allow` with its reason —
 * `exempt` is only for the deliberate wiring sites named below.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, posix, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Matches `import … from "x"` and `export … from "x"`, including multi-line
 * clauses. Re-exports count: `export type { T } from "@/infrastructure/…"`
 * propagates an infrastructure type to every consumer of the module, which is
 * exactly the coupling this rule exists to catch.
 *
 * The clause is `[^;]*?` rather than `[\s\S]*?` because an import clause never
 * contains a semicolon, while an unbounded span happily runs from a from-less
 * statement (`export type X = …;`) to the `from` of a *later* import — pinning
 * the wrong keyword to it and reporting a value import as type-only.
 */
const STATIC_IMPORT_RE = /(?:^|\n)[ \t]*(?:import|export)\b([^;]*?)from[ \t]*["']([^"']+)["']/g;

/**
 * `import("x")`, which has no `from` for the pattern above to find: `await
 * import("x")` at runtime and `import("x").T` in a type position. Either one
 * binds the two modules exactly as a top-level import does, so a rule that
 * could not see them would be trivial to step around.
 */
const INLINE_IMPORT_RE = /\bimport[ \t]*\([ \t]*["']([^"']+)["']/g;

export interface ModuleImport {
  spec: string;
  /** True for `import type …` / `export type …`, whose cost is compile-time only. */
  typeOnly: boolean;
  /** True for `import("x")`. Only a *static* import joins a module's own graph. */
  dynamic: boolean;
}

export function parseImports(source: string): ModuleImport[] {
  return [
    ...[...source.matchAll(STATIC_IMPORT_RE)].map((match) => ({
      spec: match[2]!,
      // `import { type A }` mixes a type in with value imports — not type-only.
      typeOnly: /^type\b/.test((match[1] ?? "").trim()),
      dynamic: false,
    })),
    ...[...source.matchAll(INLINE_IMPORT_RE)].map((match) => ({
      spec: match[1]!,
      // Separating a runtime `await import()` from a type-position one needs a
      // parser. The stricter reading wins: a banned target is reported either way.
      typeOnly: false,
      dynamic: true,
    })),
  ];
}

/** `src/application/foo/bar.ts` → `application`. */
function layerOf(relPath: string): string | null {
  return /^src\/([^/]+)/.exec(relPath)?.[1] ?? null;
}

/** `@/infrastructure/db/keys` → `infrastructure`; bare packages → null. */
function targetLayer(spec: string): string | null {
  return /^@\/([^/]+)/.exec(spec)?.[1] ?? null;
}

/**
 * Rewrite a relative specifier into the `@/…` form every rule matches on, so
 * `../../infrastructure/db/client` is classified exactly like
 * `@/infrastructure/db/client`. Without this the rules read a null target layer
 * for any relative import and pass it — the whole dependency rule is one `../`
 * away from being unenforced.
 */
function resolveSpec(spec: string, fromPath: string): string {
  if (!spec.startsWith(".")) {
    return spec;
  }
  const resolved = posix.join(posix.dirname(fromPath), spec);
  return resolved.startsWith("src/") ? `@/${resolved.slice("src/".length)}` : resolved;
}

interface Rule {
  name: string;
  /** Which layer(s) the rule governs. */
  from: string | string[];
  /** True when importing `spec` from this layer is a violation. */
  banned: (spec: string) => boolean;
  /**
   * Files the rule does not govern at all. Reserved for deliberate composition
   * sites — never for "we have not fixed this yet", which belongs in `allow`.
   */
  exempt?: (relPath: string) => boolean;
  /** Frozen current violations, sorted. Empty means the rule is fully enforced. */
  allow: string[];
}

/**
 * Deliberate wiring sites (docs/ARCHITECTURE.md): these compose adapters for a
 * route exactly as the composition root does. They are a rule EXCEPTION, not an
 * allowlist entry — folding a permanent exception into the allowlist would
 * destroy "the list is empty" as the signal that the rule is fully enforced.
 */
const APP_WIRING_SITES = ["src/app/api/chats/_deps.ts", "src/app/api/slack/events/_lib/"];

const RULES: Rule[] = [
  {
    name: "domain imports no other layer",
    from: "domain",
    banned: (spec) => {
      const target = targetLayer(spec);
      return target !== null && target !== "domain";
    },
    allow: [],
  },
  {
    name: "domain imports no framework, AWS SDK or auth library",
    from: "domain",
    banned: (spec) => /^(next|react|@aws-sdk|better-auth)/.test(spec),
    allow: [],
  },
  {
    name: "application imports no infrastructure or app",
    from: "application",
    banned: (spec) => ["infrastructure", "app"].includes(targetLayer(spec) ?? ""),
    // Application code holds ports only; every adapter it uses is injected by
    // the composition root rather than imported.
    allow: [],
  },
  {
    name: "infrastructure imports no application or app",
    from: "infrastructure",
    banned: (spec) => ["application", "app"].includes(targetLayer(spec) ?? ""),
    allow: [],
  },
  {
    // src/shared is the bottom of the graph: pure helpers with no knowledge of
    // any layer. Anything needing a repository, a port or config belongs above it.
    // A sibling helper is not "the app", so `@/shared/…` — which is also what a
    // relative import inside this directory resolves to — stays allowed.
    name: "shared imports nothing from the app",
    from: "shared",
    banned: (spec) => spec.startsWith("@/") && targetLayer(spec) !== "shared",
    allow: [],
  },
  {
    // The composition root wires everything, so an adapter importing it would
    // close a cycle: container -> adapter -> container. Use cases are the same
    // rule seen from the other side — they are handed their dependencies and
    // must never pull them, which is the coupling M2 and M3 removed.
    name: "adapters and use cases do not import the composition root",
    from: ["infrastructure", "application"],
    banned: (spec) => spec === "@/lib/container",
    allow: [],
  },
  {
    // The direct rule above reads clean while a use case reaches the AWS SDK
    // through `lib`: three lib modules compose infrastructure, and importing
    // one of them is pulling what should be injected — which is exactly how
    // the admin check once dragged the settings store into the application
    // layer. Only lib leaves with no imports of their own stay importable.
    name: "application imports nothing from lib but its pure leaves",
    from: "application",
    banned: (spec) => spec.startsWith("@/lib/") && spec !== "@/lib/runMetrics",
    allow: [],
  },
  {
    // The other half of the side door: a lib module that composes
    // infrastructure is a wiring module and is named here, so every module
    // this rule does not name stays a leaf and the rule above keeps meaning
    // "no side door" as lib grows.
    name: "lib imports no infrastructure outside its wiring modules",
    from: "lib",
    banned: (spec) => targetLayer(spec) === "infrastructure",
    exempt: (relPath) =>
      [
        "src/lib/container.ts",
        "src/lib/auth.ts",
        "src/lib/runtime-settings.ts",
        // The same shape as `runtime-settings`: one repository read behind an
        // authorization question, composed here because the answer is needed
        // before any use case exists to be handed it — `withAuth` resolves the
        // caller's workspace before a handler runs at all.
        "src/lib/workspace.ts",
      ].includes(relPath),
    allow: [],
  },
  {
    name: "app imports no infrastructure outside its wiring sites",
    from: "app",
    banned: (spec) => targetLayer(spec) === "infrastructure",
    exempt: (relPath) => APP_WIRING_SITES.some((site) => relPath.startsWith(site)),
    allow: [],
  },
  {
    // App chrome (the header the root layout mounts, the sign-in button) is
    // presentation like `app`, but lived outside every rule above — the one
    // slice of the tree where an adapter import would have passed unnoticed.
    name: "components imports no infrastructure or application",
    from: "components",
    banned: (spec) => ["infrastructure", "application"].includes(targetLayer(spec) ?? ""),
    allow: [],
  },
];

/** `relative()` yields OS separators; the allowlists are written with `/`. */
const SOURCE_FILES = walk(SRC).map((absolute) => ({
  path: relative(ROOT, absolute).split("\\").join("/"),
  text: readFileSync(absolute, "utf8"),
}));

function governs(rule: Rule, relPath: string): boolean {
  const layer = layerOf(relPath);
  return layer !== null && (Array.isArray(rule.from) ? rule.from : [rule.from]).includes(layer);
}

function violationsOf(rule: Rule): string[] {
  const found: string[] = [];
  for (const file of SOURCE_FILES) {
    if (!governs(rule, file.path)) continue;
    if (rule.exempt?.(file.path)) continue;
    for (const { spec, typeOnly } of parseImports(file.text)) {
      if (rule.banned(resolveSpec(spec, file.path))) {
        found.push(`${file.path} -> ${spec}${typeOnly ? " (type)" : ""}`);
      }
    }
  }
  return found.sort();
}

describe("layer boundaries", () => {
  it.each(RULES.map((rule) => [rule.name, rule] as const))("%s", (_name, rule) => {
    expect(violationsOf(rule)).toEqual([...rule.allow].sort());
  });
});

/**
 * Single-owner invariants.
 *
 * The rules above enforce which direction an import may point. They say nothing
 * about the same rule being written twice, which is the failure this codebase
 * actually kept hitting: `McpTool` reached four definitions that had already
 * drifted apart (one carried `inputSchema`, another made `description`
 * required), the DynamoDB conditional-write name was spelled out at seven call
 * sites — and only one of them handled the transactional form — and the image
 * usage collapse was derived independently four times.
 *
 * Each entry below names a decision and the file that owns it. A second copy
 * fails here, in the same spirit as the allowlists: the point is not to have a
 * tidy list, it is that adding a copy is not quietly possible.
 */
interface SingleOwner {
  /** The decision, phrased as what would be inconsistent if it were duplicated. */
  what: string;
  /** Matches the definition. Deliberately narrow — a loose pattern is noise. */
  pattern: RegExp;
  owner: string;
  /** Layers the pattern may legitimately also appear in (never the owner's). */
  alsoAllowedIn?: string[];
  /**
   * Path prefixes where a copy is legitimate. Prefer this to `alsoAllowedIn`
   * whenever the exemption is really about a few directories: a layer exemption
   * covers everything beneath it, and for `app` that includes the API route
   * handlers, which are exactly where a re-derived decision does damage.
   */
  alsoAllowedUnder?: string[];
  /**
   * Restrict the check to files under this path prefix, for a decision that is
   * only a duplicate *inside* one subsystem. Narrower than `alsoAllowedIn`,
   * which works per layer and so cannot exempt siblings of the owner.
   */
  within?: string;
}

const SINGLE_OWNERS: SingleOwner[] = [
  {
    what: "the shape of an MCP tool",
    pattern: /^export interface McpTool\b/m,
    owner: "src/domain/mcp/types.ts",
  },
  {
    // The two ways an MCP entry reaches an address the SSRF guard rejects:
    // provenance (we started the container) and declaration (an operator put the
    // host's suffix in this deployment's configuration). Four call sites ask —
    // registration, update, the console's probe, and dispatch — and a fifth that
    // answered for itself would be a hole in the outbound boundary rather than a
    // duplicated constant. The pattern matches the suffix match itself, which is
    // the part a copy would get subtly wrong.
    what: "which hosts may skip the outbound URL guard",
    pattern: /endsWith\(`\.\$\{/,
    owner: "src/domain/mcp/types.ts",
  },
  {
    what: "which storage errors mean a lost conditional write",
    pattern: /ConditionalCheckFailedException/,
    owner: "src/application/errors.ts",
    // The adapters raise it; only the application layer must not re-derive it.
    alsoAllowedIn: ["infrastructure"],
  },
  {
    what: "collapsing an image model's three token counts into a usage row",
    pattern: /textInputTokens \+/,
    owner: "src/domain/llm/models.ts",
  },
  {
    what: "constant-time secret comparison",
    pattern: /timingSafeEqual\(/,
    owner: "src/shared/timingSafe.ts",
  },
  {
    what: "parsing a comma-separated config list",
    pattern: /\.split\(","\)/,
    owner: "src/shared/parseList.ts",
  },
  {
    // Two sync paths read a frontmatter block — SKILL.md and TOOL.md — and a
    // second parser would let the same document mean different things depending
    // on which repository it came from. The pattern matches the delimiter regex,
    // which is where a copy starts.
    what: "parsing a markdown frontmatter block",
    pattern: /\^---\\r\?\\n/,
    owner: "src/shared/frontmatter.ts",
  },
  {
    what: "the subagent nesting limit",
    pattern: /MAX_SUBAGENT_DEPTH\s*=/,
    owner: "src/application/execution/subagentRunner.ts",
  },
  {
    what: "the per-run MCP tool cap",
    pattern: /MAX_MCP_TOOLS_PER_RUN\s*=/,
    owner: "src/application/execution/mcpTools.ts",
  },
  {
    what: "how many agents one dispatch may run",
    pattern: /MAX_DISPATCH_TASKS\s*=/,
    owner: "src/application/llm/engine.ts",
  },
  {
    // Where the subtleties of a hand-rolled merge live: exactly one in-flight
    // `next()` per source, return values kept at their own index rather than in
    // arrival order, and closing that is deliberately never awaited. A second
    // copy gets one of those three wrong.
    what: "merging concurrent generators",
    pattern: /IteratorResult</,
    owner: "src/shared/mergeGenerators.ts",
  },
  {
    // Two consumers derived this identically, and they would have drifted the
    // moment one of them had to track more than one chain at a time — which is
    // exactly what dispatching several agents at once made necessary.
    what: "deriving the transfer chain a chunk came from",
    pattern: /authorPath \?\? \(/,
    owner: "src/app/_lib/authorPaths.ts",
  },
  {
    // Every stream consumer used to reason "no `done` seen → cut off at a
    // limit", which misreports a cancellation and a mid-stream error as a
    // length stop. `chunkTermination` owns the done / finishReason / error →
    // reason mapping; a consumer reads the reason through it, never the raw
    // fields. The pattern matches ANY `.done` property read — the first
    // spelling (`chunk\.done`) pinned only the literal receiver name, so a
    // consumer that called its loop variable anything else walked straight
    // past the guard. The exemptions are the files that read an
    // `IteratorResult`'s `.done` (generator plumbing, not chunk semantics) —
    // plus the engine, whose pass-through keep-list mentions the fields
    // without deciding anything from them.
    what: "deriving why a run ended from its chunks",
    pattern: /\.done\b|\.finishReason\b/,
    owner: "src/domain/llm/types.ts",
    alsoAllowedUnder: [
      "src/application/llm/engine.ts",
      "src/application/execution/subagentRunner.ts",
      "src/app/api/_lib/sse.ts",
      "src/shared/mergeGenerators.ts",
      "src/infrastructure/slack/profileCache.ts",
    ],
  },
  {
    what: "the 401 response body",
    pattern: /error: "Unauthorized"/,
    owner: "src/shared/unauthorized.ts",
  },
  {
    // A second copy would inevitably be the naive `toString("utf-8")`, which
    // never fails and so silently turns a PDF into replacement characters. That
    // is the bug this exists to make un-writable, not a style preference.
    what: "deciding whether bytes are UTF-8 text",
    pattern: /Buffer\.from\(text, "utf-8"\)\.equals\(/,
    owner: "src/shared/utf8Text.ts",
  },
  {
    // Ten copies, and the door they all went through checked nothing.
    what: "the entry name rule",
    pattern: /\/\^\[a-z0-9-\]\+\$\//,
    owner: "src/shared/slug.ts",
  },
  {
    // The stricter sibling: a slug that must also be a DNS label, because it
    // names a Docker container and an SSM parameter path. The create route,
    // both provisioners and the console form each spelled it out.
    what: "the managed-workload name rule",
    pattern: /\[a-z0-9\]\[a-z0-9-\]\{0,62\}/,
    owner: "src/shared/slug.ts",
  },
  {
    what: "user-document caps",
    pattern: /MAX_DOCUMENT_CHARS_PER_TURN =/,
    owner: "src/domain/llm/documentLimits.ts",
  },
  {
    // Record points are added one at a time — a reveal here, a delete there —
    // and each one that assembles its own row is a row the reader cannot group
    // with the others. The pattern matches building the event (stamping the id
    // and timestamp), not calling `recordAudit`, which every record point does.
    what: "writing an audit row",
    pattern: /action: input\.action/,
    owner: "src/application/audit/auditLog.ts",
  },
  {
    // Every other bound is per item or per turn; this is the one that knows the
    // sum a run may accumulate, derived from the model's context window. The
    // pattern matches reading `.contextWindow` — a second derivation starts by
    // reading the window somewhere else, with its own chars-per-token guess.
    what: "deriving a run's context budget from the model's window",
    pattern: /\.contextWindow\b/,
    owner: "src/application/llm/contextBudget.ts",
  },
  {
    // The wrapper a model reads around an attachment. A chat replays a stored
    // document by rebuilding it, so a second spelling would make a replayed turn
    // differ from the one that was sent.
    what: "how an attached document is framed in a turn",
    pattern: /\[Attached file /,
    owner: "src/application/llm/documentParts.ts",
  },
  {
    // Every line already carried a `[scope]` prefix by convention, and the
    // convention was the only thing holding it: nothing stopped a new spelling,
    // and none of them said which run they came from. `domain` is exempt because
    // it imports nothing from `@/` at all — not even `shared` — so its one
    // counter-keeping line cannot reach the logger and stays a bare call.
    what: "writing to the console",
    pattern: /(?:^|[\s;{(])console\.(?:log|warn|error|info)\(/m,
    owner: "src/shared/logger.ts",
    alsoAllowedIn: ["domain"],
    // The API-reference page ships a Node.js SDK sample *containing* a
    // `console.log` call. It is text shown to a user, not a call this app makes.
    alsoAllowedUnder: ["src/app/projects/[name]/api-reference/"],
  },
  {
    // Four functions admit a top-level run, and each used to open the in-flight
    // metric for itself — which is exactly why the daily cost guard had four
    // places it could have been forgotten. `openRun` is now the one bracket, so
    // a fifth entry point that skips it is missing its metric too, and that is
    // what this catches. The pattern matches the *call*, not the definition in
    // `lib/runMetrics.ts`.
    what: "what wraps a top-level run",
    pattern: /^\s*beginRun\(\);/m,
    owner: "src/application/execution/runBracket.ts",
  },
  {
    // The version path and the image path each derived this, with opposite
    // comparison operators — one rejected on `>= rate`, the other accepted on
    // `< rate`. The pattern matches the rate fallback, which is where a copy
    // starts.
    what: "whether a run's trace is sampled",
    pattern: /traceSampleRate \?\?/,
    owner: "src/application/execution/traceLifecycle.ts",
  },
  {
    // "When does this schedule fire" is a wall-clock question, and reading a
    // wall clock in an arbitrary timezone goes through `Intl`'s part formatter.
    // A second reader would be a second cron semantics — the DST and dom/dow
    // decisions live with the one that exists.
    what: "evaluating when a schedule fires",
    pattern: /formatToParts\(/,
    owner: "src/domain/trigger/cron.ts",
  },
  {
    // Three call sites used to ask this for themselves, so a new project type
    // meant finding all three. They now ask the facade and only decide how to
    // serialise its answer.
    what: "which project type runs which way",
    pattern: /projectType === "image"/,
    owner: "src/application/execution/deps.ts",
    // The console decides which panels and docs a project type gets, which is a
    // separate question from how it runs. Scoped to the console pages rather
    // than the whole `app` layer: one of the copies this owner replaced lived in
    // an API route handler, which a layer-wide exemption would let back in.
    alsoAllowedUnder: ["src/app/projects/"],
  },
  {
    // Two transports answer the same question — stream, or post and edit — and
    // a new Slack entry point that picks one for itself is a second copy of the
    // fallback, the pacing and the delta bookkeeping. The pattern matches the
    // *call* that ends a streamed reply, not the client method or the port
    // declaration (both of which break the argument across lines).
    what: "how a Slack reply is delivered",
    pattern: /stopStream\(token,/,
    owner: "src/application/slack/replyStream.ts",
  },
  {
    // Three Slack modules take this port. Each declaring the subset it happens
    // to call is how the four `McpTool` definitions started.
    what: "the Slack Web API surface a run uses",
    pattern: /interface SlackClientPort/,
    owner: "src/application/slack/types.ts",
  },
  {
    // The agent half of the same dispatch, which cannot be checked tree-wide:
    // `projectType !== "agent"` is also how several use cases validate what a
    // project supports (a Slack bot, a chat, a tools capability), and that is a
    // different question from how a run is dispatched. Inside the execution
    // facade there is no second question, so the check is scoped to it — three
    // modules there used to answer it for themselves.
    what: "how the execution facade dispatches an agent project",
    pattern: /projectType [!=]== "agent"/,
    owner: "src/application/execution/deps.ts",
    within: "src/application/execution/",
  },
];

describe("single owners", () => {
  it.each(SINGLE_OWNERS.map((o) => [o.what, o] as const))("%s", (_what, owner) => {
    const scope = owner.within
      ? SOURCE_FILES.filter((file) => file.path.startsWith(owner.within!))
      : SOURCE_FILES;
    const holders = scope.filter((file) => owner.pattern.test(file.text)).map((f) => f.path);
    const unexpected = holders.filter(
      (path) =>
        path !== owner.owner &&
        !(owner.alsoAllowedIn ?? []).includes(layerOf(path) ?? "") &&
        !(owner.alsoAllowedUnder ?? []).some((prefix) => path.startsWith(prefix)),
    );
    // Both directions matter: a second copy fails, and so does the owner losing
    // the definition (which would otherwise read as a pass).
    expect({ owner: holders.includes(owner.owner), copies: unexpected }).toEqual({
      owner: true,
      copies: [],
    });
  });
});

/**
 * Rows that belong to no tenant, each because of a decision rather than an
 * oversight. Everything else must be scoped, and the test below is what stops a
 * new builder joining this list by accident: a key is the only thing standing
 * between two tenants, so an unscoped one is a cross-tenant read that looks
 * exactly like a working query.
 */
const UNSCOPED_KEYS = new Set([
  // Better Auth's own rows. A person is not a tenant's property and may belong
  // to more than one, so the user and its unique-field locks stay global.
  "auth",
  "authModelPartition",
  "authUniqueLookup",
  "authUnique",
  // App-wide settings: infrastructure this process is bound to. A per-tenant
  // layer over it is its own milestone, and would be a second builder.
  "settings",
  // The tenant registry itself — reading the list of tenants from inside one
  // would be circular.
  "organization",
  "organizationPartition",
  // A membership is what decides a scope, so it cannot live inside one.
  "membership",
  "membershipUserPartition",
]);

/** Sort-key fragments, which carry no partition and so no tenant. */
const KEY_FRAGMENTS = /Prefix$/;

describe("tenant scope", () => {
  const source = readFileSync(join(ROOT, "src/infrastructure/db/keys.ts"), "utf8");
  const builders = [...source.matchAll(/^ {2}(\w+): \(([^)]*)\)/gm)].map((match) => ({
    name: match[1]!,
    firstParam: (match[2] ?? "").split(",")[0]?.trim().split(":")[0]?.trim() ?? "",
  }));

  it("finds the builders it is meant to check", () => {
    // Without this the regex could silently stop matching and the rule would
    // pass by finding nothing — the failure every scanner here is written to
    // avoid.
    expect(builders.length).toBeGreaterThan(20);
  });

  it("scopes every key builder to a tenant", () => {
    const unscoped = builders
      .filter((builder) => !UNSCOPED_KEYS.has(builder.name) && !KEY_FRAGMENTS.test(builder.name))
      .filter((builder) => builder.firstParam !== "tenant")
      .map((builder) => builder.name);
    expect(unscoped).toEqual([]);
  });

  it("gives the re-keying migration every prefix it has to move", () => {
    /*
     * `scripts/retenant-table.ts` holds a second spelling of what `scope()`
     * prefixes, and it cannot derive the list at runtime — it scans raw items,
     * not builders. A prefix present here and missing there is a row the
     * migration leaves at its unprefixed key while reporting `moved N of M`,
     * and the script's own re-run safety makes that permanent: the second pass
     * finds nothing new. `SETTINGS#workspace` was exactly that.
     *
     * The literal after `scope(tenant)}` is captured whole, so a key that
     * shares a stem with an unscoped one (`SETTINGS#workspace` against
     * `SETTINGS#app`) is distinguished rather than swept up.
     */
    const scoped = [...source.matchAll(/\$\{scope\(tenant\)\}([A-Z][A-Za-z0-9#]*)/g)].map(
      (match) => match[1]!,
    );
    expect(scoped.length).toBeGreaterThan(10);
    const script = readFileSync(join(ROOT, "scripts/retenant-table.ts"), "utf8");
    const listed = new Set(
      [...script.matchAll(/^ {2}"([A-Z][A-Za-z0-9#]*)",$/gm)].map((match) => match[1]!),
    );
    expect([...new Set(scoped)].filter((prefix) => !listed.has(prefix)).sort()).toEqual([]);
  });
});

/**
 * A synthetic event read from inside a state updater.
 *
 * React nulls `SyntheticEvent.currentTarget` once the handler returns — it only
 * means anything while the event is being dispatched. A `setState` updater is
 * *not* run then; React defers it to the next render. So
 * `setX(prev => ({ ...prev, k: e.currentTarget.value }))` throws
 * "Cannot read properties of null" whenever React batches, which on the admin
 * settings page it did on every load.
 *
 * The value has to be read in the handler's own scope and closed over. This
 * catches the shape rather than the symptom: an updater arrow whose body still
 * mentions the event.
 */
const DEFERRED_EVENT_READ =
  /set[A-Z]\w*\(\s*\((?:prev|current)\w*\)\s*=>[\s\S]{0,400}?currentTarget/;

describe("react event handling", () => {
  it("never reads currentTarget inside a state updater", () => {
    const offenders = SOURCE_FILES.filter(
      (file) => file.path.endsWith(".tsx") && DEFERRED_EVENT_READ.test(file.text),
    ).map((file) => file.path);
    expect(offenders.sort()).toEqual([]);
  });
});

/**
 * A create modal that keeps its draft.
 *
 * These modals are mounted for the life of the page — `opened` is a prop, not a
 * mount — so their `useState` fields outlive being closed. After a successful
 * create the next open came up still holding the item that had just been saved,
 * and the operator either cleared every field by hand or submitted a name the
 * registry already had.
 *
 * Clearing them means naming every field, which is exactly what drifts when a
 * field is added later, so the rule is mechanical rather than a comment: a
 * component that calls `onCreated()` clears through a `reset()` immediately
 * before it, and that `reset()` touches every field setter the component
 * declares. Adding a field and forgetting its reset fails here.
 */
const NOT_A_FIELD = new Set(["setSubmitting", "setError"]);

/** The component that calls `onCreated()`, from its `function` line to the end of the file. */
function createModalBody(text: string): string {
  const call = text.indexOf("onCreated();");
  const declarations = [...text.matchAll(/^(?:export )?function \w+\(/gm)];
  const owner = declarations.filter((match) => match.index! < call).at(-1);
  return owner ? text.slice(owner.index!) : "";
}

describe("create modals", () => {
  const modals = SOURCE_FILES.filter(
    (file) => file.path.endsWith(".tsx") && file.text.includes("onCreated();"),
  );

  // Without this the scan going blind — a renamed callback, a changed call
  // shape — would read as every modal passing.
  it("finds the modals to check", () => {
    expect(modals.length).toBeGreaterThan(0);
  });

  it.each(modals.map((file) => file.path))("%s clears every field it declares", (path) => {
    const body = createModalBody(SOURCE_FILES.find((file) => file.path === path)!.text);
    const fields = [...body.matchAll(/const \[\w+, (set\w+)\] = useState/g)]
      .map((match) => match[1]!)
      .filter((setter) => !NOT_A_FIELD.has(setter));
    const reset = /\n {2}function reset\(\) \{\n([\s\S]*?)\n {2}\}/.exec(body)?.[1] ?? "";

    expect({
      clearsBeforeOnCreated: /reset\(\);\n\s*onCreated\(\);/.test(body),
      unreset: fields.filter((setter) => !reset.includes(`${setter}(`)),
    }).toEqual({ clearsBeforeOnCreated: true, unreset: [] });
  });
});

/**
 * What the Edge runtime has to be able to load.
 *
 * Next compiles `instrumentation.ts` for **both** the Node and Edge runtimes.
 * `proxy.ts` defaults to Node as of Next 16, but it stays on this list because
 * it is the one file a deploy target may lift out to its edge network, and it
 * runs on every page: a Node builtin anywhere in its transitive imports takes
 * the whole console down while every `/api/*` route keeps working, because those
 * are outside the matcher. That asymmetry is exactly what let it ship once: the
 * API surface tested clean.
 *
 * `pnpm build` only *warns*. This fails.
 */
const EDGE_ENTRY_POINTS = ["src/instrumentation.ts", "src/proxy.ts"];

/** The Node builtins the Edge runtime implements. Everything else is banned. */
const EDGE_SAFE_NODE_BUILTINS = new Set([
  "node:async_hooks",
  "node:buffer",
  "node:events",
  "node:util",
  "node:assert",
]);

/** Resolve an `@/…` specifier to the source file it names, if we have one. */
function fileFor(spec: string): { path: string; text: string } | undefined {
  if (!spec.startsWith("@/")) {
    return undefined;
  }
  const base = `src/${spec.slice(2)}`;
  return SOURCE_FILES.find((file) =>
    [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].includes(file.path),
  );
}

describe("edge runtime compatibility", () => {
  it.each(EDGE_ENTRY_POINTS)("%s pulls in no Node-only builtin", (entry) => {
    const seen = new Set<string>();
    const offenders: string[] = [];
    const queue = SOURCE_FILES.filter((file) => file.path === entry);
    expect(queue).toHaveLength(1);
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file.path)) {
        continue;
      }
      seen.add(file.path);
      // Static value imports only. A `import()` kept lexically inside the
      // `NEXT_RUNTIME` check folds away in the Edge build — which is the rule
      // `instrumentation.ts` already documents — and a type import is erased.
      for (const { spec } of parseImports(file.text).filter((i) => !i.dynamic && !i.typeOnly)) {
        const resolved = resolveSpec(spec, file.path);
        if (resolved.startsWith("node:") && !EDGE_SAFE_NODE_BUILTINS.has(resolved)) {
          offenders.push(`${file.path} -> ${resolved}`);
          continue;
        }
        const next = fileFor(resolved);
        if (next) {
          queue.push(next);
        }
      }
    }
    expect(offenders.sort()).toEqual([]);
  });
});

/**
 * The scanner is the thing every rule above trusts. A regex that silently stops
 * matching would report zero violations everywhere and read as a clean pass, so
 * its parsing and its reach are asserted directly.
 */
describe("scanner", () => {
  it("reads the whole source tree", () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(100);
    expect(SOURCE_FILES.some((f) => f.path === "src/application/llm/engine.ts")).toBe(true);
  });

  it("still sees a dependency that is known to exist", () => {
    const engine = SOURCE_FILES.find((f) => f.path === "src/application/llm/engine.ts")!;
    const specs = parseImports(engine.text).map((i) => i.spec);
    expect(specs.some((spec) => spec.startsWith("@/domain/"))).toBe(true);
  });

  it("parses value, type, multi-line and re-export forms", () => {
    const parsed = parseImports(
      [
        `import { a } from "@/domain/a";`,
        `import type { B } from "@/domain/b";`,
        `import {\n  c,\n  d,\n} from "@/domain/cd";`,
        `export type { E } from "@/infrastructure/e";`,
        `import { type F, g } from "@/domain/fg";`,
      ].join("\n"),
    );
    expect(parsed).toEqual([
      { spec: "@/domain/a", typeOnly: false, dynamic: false },
      { spec: "@/domain/b", typeOnly: true, dynamic: false },
      { spec: "@/domain/cd", typeOnly: false, dynamic: false },
      { spec: "@/infrastructure/e", typeOnly: true, dynamic: false },
      // An inline `type` among value imports is still a value import.
      { spec: "@/domain/fg", typeOnly: false, dynamic: false },
    ]);
  });

  it("parses dynamic and type-position import() forms", () => {
    const parsed = parseImports(
      [
        `const { a } = await import("@/lib/config");`,
        `type X = import("@/infrastructure/db/client").Foo;`,
      ].join("\n"),
    );
    expect(parsed).toEqual([
      { spec: "@/lib/config", typeOnly: false, dynamic: true },
      { spec: "@/infrastructure/db/client", typeOnly: false, dynamic: true },
    ]);
  });

  it("does not let a from-less statement swallow the next import", () => {
    const parsed = parseImports(
      [`export type A = () => number;`, `import { b } from "@/domain/b";`].join("\n"),
    );
    // One import, and a value one — not `A`'s `export type` pinned to `b`.
    expect(parsed).toEqual([{ spec: "@/domain/b", typeOnly: false, dynamic: false }]);
  });

  it("flags a banned import that is not on the allowlist", () => {
    const rule = RULES.find((r) => r.from === "domain")!;
    expect(rule.banned("@/infrastructure/db/client")).toBe(true);
    expect(rule.banned("@/domain/llm/types")).toBe(false);
  });

  it("resolves a relative specifier to the alias form the rules match on", () => {
    // The escape hatch the rules would otherwise have: same target, no `@/`.
    expect(resolveSpec("../../infrastructure/db/client", "src/domain/llm/types.ts")).toBe(
      "@/infrastructure/db/client",
    );
    expect(resolveSpec("./types", "src/domain/llm/channel.ts")).toBe("@/domain/llm/types");
    // Package specifiers are left alone; so is anything resolving outside src.
    expect(resolveSpec("next/server", "src/app/page.tsx")).toBe("next/server");
    expect(resolveSpec("../../scripts/x", "src/app/page.tsx")).toBe("scripts/x");
  });

  it("bans a relative cross-layer import exactly as it bans the alias form", () => {
    const rule = RULES.find((r) => r.from === "domain")!;
    const spec = resolveSpec("../../infrastructure/db/client", "src/domain/llm/types.ts");
    expect(rule.banned(spec)).toBe(true);
    // A sibling inside the same layer resolves too, and stays legal.
    expect(rule.banned(resolveSpec("./types", "src/domain/llm/channel.ts"))).toBe(false);
  });
});
