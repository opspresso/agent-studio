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

/**
 * `import "x"` — a side-effect import binds no name and carries no `from`, so
 * neither pattern above could see it. It joins the module graph exactly as a
 * static import does (`instrumentation.ts` documents modules that are wired by
 * import side effect alone), so a rule blind to it was one bare line away from
 * unenforced.
 */
const SIDE_EFFECT_IMPORT_RE = /(?:^|\n)[ \t]*import[ \t]*["']([^"']+)["']/g;

/**
 * Comments talk about modules and the environment without touching them, and
 * the import pattern's `[^;]*?` clause happily spans a docblock: a sentence
 * like `apart from "could not decide".` between an `export` keyword and the
 * next semicolon minted a ghost import with that phrase as its specifier.
 * Harmless while every rule was a blocklist — a ghost has no layer — but a
 * whitelist rule reads a ghost as a violation, so the scan parses code only.
 * The `//` stripper skips `://` so a URL inside a string survives.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/[^\n]*/g, "");
}

/**
 * Every named binding taken from a module, `type` prefixes and `as` aliases
 * stripped.
 *
 * A *module* is the wrong grain for some questions.
 * `@/application/image/generateImage` exports one use case, so importing it at
 * all is the signal; `@/application/execution/runProject` is the whole execution
 * facade, and "who may start an agent run" asks about one export of it.
 *
 * `import * as ns` binds every export at once, so it answers **yes to every
 * name** rather than none. Returning `[]` for it — which reads reasonable, since
 * no clause spells a name out — is an escape hatch from both by-name rules
 * below: `import * as rp from "…/runProject"` then `rp.executeAgent(…)` is a
 * fourth entry point neither of them can see. Not hypothetical in this codebase,
 * which already imports the engine that way in two places.
 */
const NAMESPACE_IMPORT = "*";

function parseNames(clause: string): string[] {
  if (/\*\s+as\s+\w/.test(clause)) {
    return [NAMESPACE_IMPORT];
  }
  const braces = /\{([^}]*)\}/.exec(clause);
  if (!braces?.[1]) {
    return [];
  }
  return braces[1]
    .split(",")
    .map((entry) => entry.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim())
    .filter((name) => name.length > 0);
}

/** Does this import bring `name` into scope, whether by clause or wholesale? */
function bindsName(imported: ModuleImport, name: string): boolean {
  return imported.names.includes(name) || imported.names.includes(NAMESPACE_IMPORT);
}

export interface ModuleImport {
  spec: string;
  /** True for `import type …` / `export type …`, whose cost is compile-time only. */
  typeOnly: boolean;
  /** True for `import("x")`. Only a *static* import joins a module's own graph. */
  dynamic: boolean;
  /** Named bindings taken from the module; empty for a default or dynamic import. */
  names: string[];
}

export function parseImports(source: string): ModuleImport[] {
  const code = stripComments(source);
  return [
    ...[...code.matchAll(STATIC_IMPORT_RE)].map((match) => ({
      spec: match[2]!,
      // `import { type A }` mixes a type in with value imports — not type-only.
      typeOnly: /^type\b/.test((match[1] ?? "").trim()),
      dynamic: false,
      names: parseNames(match[1] ?? ""),
    })),
    ...[...code.matchAll(INLINE_IMPORT_RE)].map((match) => ({
      spec: match[1]!,
      // Separating a runtime `await import()` from a type-position one needs a
      // parser. The stricter reading wins: a banned target is reported either way.
      typeOnly: false,
      dynamic: true,
      // A dynamic import's bindings are in the destructuring that follows, not
      // in a clause. Left empty rather than guessed: `["*"]` would make every
      // by-name query match `container.ts`, which imports this same facade for
      // a different export.
      names: [],
    })),
    ...[...code.matchAll(SIDE_EFFECT_IMPORT_RE)].map((match) => ({
      spec: match[1]!,
      typeOnly: false,
      dynamic: false,
      names: [],
    })),
  ];
}

/**
 * `src/application/foo/bar.ts` → `application`. A file at the root of `src/`
 * (`proxy.ts`, `instrumentation.ts`) has no directory to name a layer, so it
 * was governed by nothing: an infrastructure import there would have passed
 * every rule in this file — and `proxy.ts` is the single owner of which pages
 * are public, exactly the file that must not drift quietly. Both are
 * framework entry points, which is presentation-adjacent glue: they answer to
 * `app`'s rules.
 */
function layerOf(relPath: string): string | null {
  if (/^src\/[^/]+\.tsx?$/.test(relPath)) {
    return "app";
  }
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
const APP_WIRING_SITES = [
  "src/app/api/chats/_deps.ts",
  "src/app/api/slack/events/_lib/",
  // The Telegram webhook's bag, mirroring the Slack one: the same bound run
  // over the same repositories, plus the Bot API client and the transcript
  // store the surface keeps its history in.
  "src/app/api/telegram/webhook/_lib/",
  // And the Teams messaging endpoint's, over the same shape.
  "src/app/api/teams/messages/_lib/",
  // Assembles the A2A SDK handler over `executionDeps` per request —
  // AGENTS.md's fourth wiring site (the composition root being the first).
  // Absent from this list it passed only because no banned name crossed it yet.
  "src/app/api/a2a/[name]/route.ts",
  // The boot path: validates config, then composes the startup audit row and
  // the managed-MCP resume directly — a wiring site by construction, since the
  // composition root itself is not loaded until this file decides the runtime
  // is the Node server.
  "src/instrumentation.ts",
];

/**
 * Packages `application` may name, because the protocol *is* the contract. See
 * the rule below for why this is a list of one rather than a port.
 */
const PROTOCOL_SDKS = ["@a2a-js/"];

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
    // Once a blocklist of four regretted names (`next|react|@aws-sdk|
    // better-auth`), which left `zod`, `openai`, the MCP SDK and every other
    // package legal in the one layer whose doctrine is pure TS. The same
    // reverse rule as application's below, minus the protocol exception —
    // domain does not even get the A2A SDK.
    name: "domain imports only the domain and the standard library",
    from: "domain",
    banned: (spec) =>
      !spec.startsWith("@/") && !spec.startsWith(".") && !spec.startsWith("node:"),
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
    // `domain` is banned from the framework, the AWS SDK and the auth library by
    // name. `application` gets the rule from the other side — **the domain and
    // the standard library, and nothing else** — because a blocklist only ever
    // names the dependencies somebody already regretted. A use case reaching for
    // a client, a parser or a framework is an adapter that has not admitted it
    // yet, and it arrives as a `import type` nobody reads twice.
    //
    // Protocol SDKs are the one exception, named rather than allowlisted.
    // `@a2a-js/sdk` is it: `a2a/executor.ts` implements the SDK's
    // `AgentExecutor` and `a2a/exposure.ts` returns its `AgentCard`, so A2A's
    // shape does reach the use case. A port there would restate the protocol's
    // task lifecycle in our own types to gain nothing — there is one
    // implementation of A2A and there will be one. That is a judgement rather
    // than an oversight, which is what naming it here records; a second SDK has
    // to be argued for in the same place.
    name: "application imports only the domain and the standard library",
    from: "application",
    banned: (spec) => {
      if (spec.startsWith("@/") || spec.startsWith(".") || spec.startsWith("node:")) {
        return false;
      }
      return !PROTOCOL_SDKS.some((sdk) => spec.startsWith(sdk));
    },
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
    // The rule above governs `@/…` and a bare package specifier starts with
    // neither `@/` nor `.` — so the bottom of the graph, which everything
    // imports and the browser can reach, had no external-dependency rule at
    // all. An AWS SDK import here would have passed every check in this file.
    name: "shared imports only its siblings and the standard library",
    from: "shared",
    banned: (spec) =>
      !spec.startsWith("@/") && !spec.startsWith(".") && !spec.startsWith("node:"),
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
    // The direction nothing governed. `application → lib` is locked to one pure
    // leaf, but `lib → application` was wide open, and `runtime-settings` used
    // it: a settings reader reached into a use-case module for a parser. Nothing
    // stopped the next one from closing a cycle through `@/lib/runMetrics`. The
    // composition root is the exception by definition — assembling use cases is
    // what it is for.
    name: "lib imports no application outside the composition root",
    from: "lib",
    banned: (spec) => targetLayer(spec) === "application",
    exempt: (relPath) => relPath === "src/lib/container.ts",
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
    // `memberAccess` fronts the member repository behind a cache, the same
    // shape `runtime-settings` has with the settings repository.
    exempt: (relPath) =>
      [
        "src/lib/container.ts",
        "src/lib/auth.ts",
        "src/lib/runtime-settings.ts",
        "src/lib/memberAccess.ts",
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
 * The environment, which the import rules cannot see.
 *
 * Every rule above matches specifiers, and `process.env.X` is not one — so a
 * layer could read configuration and no boundary would notice. The failure that
 * follows is always the same: a value read at module scope becomes a
 * process-wide constant nothing declared, nobody injected, and the boot
 * validation never checked. `domain` and `shared` are the worst place for it
 * (one is pure by construction, the other is imported by everything), but
 * `infrastructure` had three of them — two MCP cache TTLs frozen at import, and
 * a retention window whose own parser fell back silently, so a typo deleted rows
 * a year early without a line in the log.
 *
 * Adapters declare their settings through `lib/config`, which owns the parse and
 * the warning; `lib` itself is where reading the environment is the job, so it
 * is outside this rule.
 *
 * `runDeadline.ts` is the one occupant, and it is *named* rather than
 * allowlisted. The run deadline is a process-level backstop that `application`
 * needs and cannot be handed one — it may not import `lib` — so it is read there
 * on purpose. Naming it is what keeps the second one from arriving quietly.
 */
const ENV_READ = /process\.env\b/;
const ENV_READERS_AT_THE_BOTTOM = ["src/shared/runDeadline.ts"];

describe("configuration reads", () => {
  // On comment-stripped text: `settingsUseCases.ts` *talks about* the
  // environment object it is handed — the composition root passes
  // `process.env` in, which is the injection this rule exists to force — and
  // a rule that could not tell prose from a read would ban the comment that
  // explains the rule.
  it("do not reach domain, shared, the adapters or the use cases", () => {
    const found = SOURCE_FILES.filter(
      (file) =>
        ["domain", "shared", "infrastructure", "application"].includes(layerOf(file.path) ?? "") &&
        !ENV_READERS_AT_THE_BOTTOM.includes(file.path) &&
        ENV_READ.test(stripComments(file.text)),
    ).map((file) => file.path);
    expect(found.sort()).toEqual([]);
  });

  it("still happen where the exception says they do", () => {
    // An exception that stopped being true would leave the rule reading
    // stricter than it is, which is the same lie as an unenforced rule.
    const stale = ENV_READERS_AT_THE_BOTTOM.filter(
      (path) =>
        !ENV_READ.test(stripComments(SOURCE_FILES.find((file) => file.path === path)?.text ?? "")),
    );
    expect(stale).toEqual([]);
  });
});

/**
 * What ships to the browser, which the layer rules cannot see.
 *
 * `src/components` is barred from `application` and `infrastructure` by a rule
 * above. `src/app` — 165 files, and the only place a client component actually
 * lives — was barred from `infrastructure` alone, so nothing stopped a
 * `"use client"` file from importing a use case. One already did:
 * `PromptPreview.tsx` reached `@/application/llm/template` for a regex over
 * `{{var}}` placeholders. That module was 29 lines with no imports of its own,
 * so it cost nothing and read as harmless — which is the point. The same line
 * naming `@/application/llm/engine` instead pulls the tool loop, the PII filter,
 * the context budget and the logger into the browser bundle, and no rule here
 * would have said a word.
 *
 * A layer is the wrong axis for this, because the boundary is not where a file
 * sits but which runtime it is compiled for. So the rule reads the directive,
 * the way the `configuration reads` rule reads `process.env`.
 *
 * The fix for the one occupant was to move the module rather than exempt the
 * import, and that is still the shape of a fix here — but not always to the same
 * place. A helper both sides *run* and no layer owns goes to `src/shared`, which
 * is what `template.ts` did. A rule or format a domain type owns goes to
 * `domain/`, which is pure TS and just as reachable from a client — `slug.ts`,
 * `frontmatter.ts` and `imageSniff.ts` came back out of `shared` for that reason.
 * And a *type* needs no move at all: a type-only import is erased before any
 * bundle exists, which is how the console names the shapes its routes and use
 * cases answer with. What must never cross is a value.
 */
/**
 * A directive may follow comments, and nearly every file here opens with a
 * docblock. Anchored without `m` this matched only a file whose very first
 * characters are the directive, so a client component written in the house
 * style — docblock, then `"use client"` — would have dropped out of the scan
 * entirely and been free to import anything.
 */
const CLIENT_DIRECTIVE = /^\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*["']use client["']/;

const SERVER_ONLY_LAYERS = ["application", "infrastructure"];

/**
 * `lib` is not a layer the rule can ban wholesale — `auth-client` is a client
 * module by construction — so its server half is named instead. Leaving it out
 * was worse than the hole it was written to close: `@/lib/container` is the
 * composition root, and a client component importing it ships every DynamoDB
 * repository, the AES cipher, both LLM channels and the AWS SDK to the browser.
 * `config` and `runtime-settings` are the same shape for environment values.
 */
const CLIENT_SAFE_LIB = ["@/lib/auth-client"];

/**
 * Every module the browser bundle can reach from a client entry point.
 *
 * The directive marks an entry, not the boundary. A module with no directive of
 * its own is compiled into the client bundle as soon as a client component
 * imports it, and one already sits in exactly that position:
 * `src/app/projects/lib/api.ts` is imported by ~19 client components and imports
 * `@/application/trigger/triggerUseCases` — type-only today, therefore erased,
 * and one word away from not being. Checking only the marked files would have
 * called that clean.
 *
 * Type-only imports are erased and stop the walk. Dynamic imports do not: a
 * `await import()` is a separate chunk, not an exclusion, and the code still
 * ships.
 */
function clientReachable(entries: typeof SOURCE_FILES): typeof SOURCE_FILES {
  const seen = new Map<string, (typeof SOURCE_FILES)[number]>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file.path)) {
      continue;
    }
    seen.set(file.path, file);
    for (const imported of parseImports(file.text)) {
      if (imported.typeOnly) {
        continue;
      }
      const next = fileFor(resolveSpec(imported.spec, file.path));
      if (next) {
        queue.push(next);
      }
    }
  }
  return [...seen.values()];
}

describe("the client bundle", () => {
  const entries = SOURCE_FILES.filter((file) => CLIENT_DIRECTIVE.test(file.text));
  const reachable = clientReachable(entries);

  // A count, not `> 0`: the scan going blind is the failure mode that reads
  // exactly like a clean pass, and 54 of 55 entries dropping out would have
  // satisfied the looser assertion. Update this number when a client component
  // is added or removed — that is the point of it.
  it("is scanned from every client entry point", () => {
    expect(entries.length).toBe(95);
    expect(entries.map((file) => file.path)).toContain(
      "src/app/projects/[name]/_components/PromptPreview.tsx",
    );
    // The directive-less module the reachability walk exists for.
    expect(reachable.map((file) => file.path)).toContain("src/app/projects/lib/api.ts");
  });

  it("reaches no application, infrastructure or server-side lib module", () => {
    const found: string[] = [];
    for (const file of reachable) {
      for (const { spec, typeOnly } of parseImports(file.text)) {
        if (typeOnly) {
          continue;
        }
        const resolved = resolveSpec(spec, file.path);
        const banned =
          SERVER_ONLY_LAYERS.includes(targetLayer(resolved) ?? "") ||
          (targetLayer(resolved) === "lib" && !CLIENT_SAFE_LIB.includes(resolved));
        if (banned) {
          found.push(`${file.path} -> ${spec}`);
        }
      }
    }
    expect(found.sort()).toEqual([]);
  });

  it("pulls no Node-only module into the browser", () => {
    // The layer rule above lets a client component import anything in
    // `shared` — and `shared` holds Node-only modules: `logger` rides on
    // `node:async_hooks`, `timingSafe` on `node:crypto`. The logger is the
    // console-writing single owner, which makes it exactly the module a
    // client component would reach for first.
    const found: string[] = [];
    for (const file of reachable) {
      for (const { spec, typeOnly } of parseImports(file.text)) {
        if (!typeOnly && spec.startsWith("node:")) {
          found.push(`${file.path} -> ${spec}`);
        }
      }
    }
    expect(found.sort()).toEqual([]);
  });
});

/**
 * A response shape is declared where the response is built.
 *
 * Eighteen of them were declared twice — once by the producer, once again by
 * the browser client — because a `"use client"` module may not *import*
 * `application/`. It may *name* one: a type-only import is erased before a
 * bundle exists. Nothing linked the copies, and they had drifted: a card type
 * widened to `Record<string, unknown>` where the producer says `AgentCard`, an
 * image result missing the warning its producer sends, a Slack view without the
 * manifest a mutation answers with — the pair that crashed the settings page.
 *
 * Checked by *name*, from the browser's side, which is the half that must not
 * restate: a type declared in a client-reachable `app` module must not share its
 * name with one a producer exports. Naming is the whole point, so an import or
 * an alias (`type ImageResult = GenerateImageOutput`) is not a declaration — a
 * body is. Producers keep declaring theirs; a route that builds the shape it
 * answers with (`ProjectSlackResponse`, `SkillSummary`) is not client-reachable,
 * because the console reaches it type-only.
 *
 * Request shapes are deliberately excluded. A console input is often narrower
 * than what the use case accepts — `CreateMcpInput` omits `source`, the sync's
 * provenance, which must not be settable from a form — so those two
 * declarations are two contracts rather than one written twice.
 */
const DECLARED_TYPE = /^export\s+(?:interface\s+([A-Za-z0-9_]+)\s*(?:extends[^{]*)?\{|type\s+([A-Za-z0-9_]+)\s*=\s*[^;]*[{|])/gm;

function declaredTypes(text: string): string[] {
  return [...stripComments(text).matchAll(DECLARED_TYPE)].map((m) => (m[1] ?? m[2])!);
}

describe("response shapes", () => {
  const reachable = clientReachable(SOURCE_FILES.filter((file) => CLIENT_DIRECTIVE.test(file.text)));
  const isProducer = (path: string) =>
    ["application", "domain"].includes(layerOf(path) ?? "") || path.startsWith("src/app/api/");
  const producerNames = new Set(
    SOURCE_FILES.filter((file) => isProducer(file.path)).flatMap((file) => declaredTypes(file.text)),
  );

  it("are named by the browser's half, never declared there", () => {
    const found: string[] = [];
    for (const file of reachable) {
      if (layerOf(file.path) !== "app" || file.path.startsWith("src/app/api/")) {
        continue;
      }
      for (const name of declaredTypes(file.text)) {
        if (!name.endsWith("Input") && producerNames.has(name)) {
          found.push(`${file.path} -> ${name}`);
        }
      }
    }
    expect(found.sort()).toEqual([]);
  });

  it("still sees both halves it compares", () => {
    // The scan going blind reads exactly like a clean pass: anchor a producer
    // declaration, a client module that reaches for one, and the walk that
    // decides which files are the browser's.
    expect(producerNames.has("SkillSummary")).toBe(true);
    expect(producerNames.has("ArtifactPage")).toBe(true);
    expect(reachable.map((file) => file.path)).toContain("src/app/projects/lib/api.ts");
    expect(declaredTypes('export interface X {\n  a: string;\n}')).toEqual(["X"]);
    // An alias names a type rather than restating it, and is not a declaration.
    expect(declaredTypes("export type ImageResult = GenerateImageOutput;")).toEqual([]);
  });
});

/**
 * Where a run's ending is classified.
 *
 * A run signal aborts for two reasons and they are not the same ending — the
 * caller left, or `MAX_RUN_DURATION_MS` stopped a run that was otherwise
 * working — so every path that composes one has to ask which it was. Two did
 * not: a transferred-to prompt child wrote the raw abort reason on its trace
 * while its parent wrote the deadline's sentence for the same event, and an
 * image child rethrew before it wrote a trace at all.
 *
 * A prose list said "four run paths" while the branch that wrote it wired five,
 * which is why this is a test: the rule is that a file composing a run deadline
 * classifies what stopped it, and the two child paths that classify without
 * composing (they run on their parent's signal) are named here so the list
 * stays the whole set rather than half of it.
 */
const RUN_ENDING_SITES = [
  "src/application/execution/imageTool.ts",
  "src/application/execution/runProject.ts",
  "src/application/execution/subagentRunner.ts",
  "src/application/image/generateImage.ts",
];

describe("a run's ending", () => {
  const bindsName = (file: (typeof SOURCE_FILES)[number], name: string) =>
    parseImports(file.text).some((imported) => imported.names.includes(name));

  it("is classified everywhere a run deadline is composed", () => {
    const composes = SOURCE_FILES.filter(
      (file) => layerOf(file.path) !== "shared" && bindsName(file, "withRunDeadline"),
    ).map((file) => file.path);
    expect(composes.sort()).toEqual(
      RUN_ENDING_SITES.filter((path) =>
        SOURCE_FILES.some((file) => file.path === path && bindsName(file, "withRunDeadline")),
      ).sort(),
    );
    expect(composes.length).toBeGreaterThan(0);
  });

  it("is classified by every site the list names", () => {
    const missing = RUN_ENDING_SITES.filter((path) => {
      const file = SOURCE_FILES.find((source) => source.path === path);
      return !file || !bindsName(file, "runEnding");
    });
    expect(missing).toEqual([]);
  });
});

/**
 * Repositories the presentation layer no longer composes.
 *
 * The `app` layer is barred from `infrastructure`, so a route reached for a
 * repository through the composition root instead — and twenty of them did,
 * importing `projectRepository` only to hand it straight back to
 * `getProject(projectRepository, name)`. Legal under every rule above, and
 * still a route handler making a composition decision: which repository, which
 * cipher, which registry lookups a version's references are validated against.
 * `refs` is what stops a version storing a dangling skill reference, and nothing
 * but convention had each caller passing it.
 *
 * The mcp, skill, agent, member and trigger slices never had this — they export
 * a `createXUseCases` factory that the composition root calls once. The project,
 * version, API-token and project-Slack slices now do too, and the free functions
 * they wrap stay exported for the application modules that already hold a
 * repository of their own.
 *
 * A name is added to this list when its slice is converted, not before: a
 * blanket ban would fail on `traceRepository` and `usageRepository`, whose
 * slices have not been through this yet, and a rule that cannot be satisfied is
 * a rule that gets deleted.
 */
const REPOSITORIES_THE_ROUTES_NO_LONGER_COMPOSE = [
  "projectRepository",
  "versionRepository",
  "traceRepository",
  "usageRepository",
  "secretCipher",
  // Not a repository but the same decision: eight routes reached into
  // `artifactStorage.objects.sign` to pick the signer that addresses a file,
  // two of them right after guarding on `artifactUseCases` — re-deriving from
  // the store what the use case they had just called was built from. The root
  // exports `signArtifactUrl`; the store itself stays where a wiring site needs
  // the pair (`chats/_deps.ts` hands both halves to the chat deps).
  "artifactStorage",
];

describe("composition in the app layer", () => {
  const wiringSite = (path: string) => APP_WIRING_SITES.some((site) => path.startsWith(site));

  it.each(REPOSITORIES_THE_ROUTES_NO_LONGER_COMPOSE)("%s reaches no route handler", (name) => {
    const found = SOURCE_FILES.filter(
      (file) =>
        layerOf(file.path) === "app" &&
        !wiringSite(file.path) &&
        parseImports(file.text).some((i) => bindsName(i, name)),
    ).map((file) => file.path);
    expect(found.sort()).toEqual([]);
  });

  it.each(REPOSITORIES_THE_ROUTES_NO_LONGER_COMPOSE)(
    "%s still reaches a wiring site or the composition root",
    (name) => {
      // Otherwise a rename would empty the rule above and read as a clean pass —
      // the same lie the `configuration reads` exception check exists to catch.
      // The composition root anchors the names no app wiring site needs:
      // `traceRepository` stopped being exported when its slice was converted,
      // so the only place left that binds it is `container.ts` itself.
      const sites = SOURCE_FILES.filter(
        (file) =>
          (wiringSite(file.path) || file.path === "src/lib/container.ts") &&
          parseImports(file.text).some((i) => bindsName(i, name)),
      );
      expect(sites.length).toBeGreaterThan(0);
    },
  );
});

/**
 * The slice a file or an import specifier belongs to, within `application` —
 * `src/application/execution/runProject.ts` and `@/application/execution/deps`
 * are both `execution`; the single-file `errors.ts` kernel is its own slice.
 */
function applicationSliceOf(pathOrSpec: string): string | null {
  const match =
    /^(?:src|@)\/application\/([^/]+)\//.exec(pathOrSpec) ??
    /^(?:src|@)\/application\/([^/.]+)(?:\.tsx?)?$/.exec(pathOrSpec);
  return match?.[1] ?? null;
}

/** Report every back edge as the dependency path that closes it. */
function cyclesInGraph(edges: Map<string, Set<string>>): string[] {
  const cycles: string[] = [];
  const done = new Set<string>();
  const visit = (node: string, path: string[]): void => {
    const at = path.indexOf(node);
    if (at >= 0) {
      cycles.push([...path.slice(at), node].join(" -> "));
      return;
    }
    if (done.has(node)) {
      return;
    }
    for (const next of edges.get(node) ?? []) {
      visit(next, [...path, node]);
    }
    done.add(node);
  };
  for (const node of [...edges.keys()].sort()) {
    visit(node, []);
  }
  return cycles.sort();
}

/**
 * Layer and slice rules still allow two files in one slice to depend on each
 * other. Type-only edges count: they keep the modules structurally inseparable
 * even when the runtime erases one direction. Dynamic imports count too: they
 * defer loading but still couple the two modules, and the scanner cannot tell
 * them apart from a type-position `import("…").T` without a parser.
 */
describe("module graph", () => {
  it("has no cycles", () => {
    const edges = new Map<string, Set<string>>();
    for (const file of SOURCE_FILES) {
      const targets = parseImports(file.text)
        .map((imported) => fileFor(resolveSpec(imported.spec, file.path))?.path)
        .filter((path): path is string => path !== undefined);
      edges.set(file.path, new Set(targets));
    }
    expect(cyclesInGraph(edges)).toEqual([]);
  });

  it("reports the path that closes a cycle", () => {
    const edges = new Map([
      ["a", new Set(["b"])],
      ["b", new Set(["a"])],
    ]);
    expect(cyclesInGraph(edges)).toEqual(["a -> b -> a"]);
  });
});

/**
 * The layer rules govern edges *between* layers; nothing governed the edges
 * between application slices, and two cycles had formed before anything said
 * so: `execution ↔ image` (the facade dispatches image runs, and the image use
 * case reached back for the run bracket that then lived in `execution`), and
 * `execution → usage → slack → execution` (the cost guard imported the slack
 * slice's token resolver, and slack's deps name the facade's input type). A
 * slice cycle is the stage before a file cycle, and it makes every member
 * slice untestable and unmovable except as a lump.
 *
 * Type-only edges count, exactly as they do in the layer rules: a type is how
 * this kind of coupling arrives first.
 */
describe("application slice graph", () => {
  it("has no cycles", () => {
    const edges = new Map<string, Set<string>>();
    for (const file of SOURCE_FILES) {
      const from = applicationSliceOf(file.path);
      if (!from) {
        continue;
      }
      for (const imported of parseImports(file.text)) {
        const to = applicationSliceOf(resolveSpec(imported.spec, file.path));
        if (to && to !== from) {
          (edges.get(from) ?? edges.set(from, new Set()).get(from)!).add(to);
        }
      }
    }
    expect(cyclesInGraph(edges)).toEqual([]);
  });

  it("still sees the graph it governs", () => {
    // The scan going blind reads exactly like a clean pass; anchor one edge
    // that exists by construction (every slice reports errors through the
    // shared kernel).
    const files = SOURCE_FILES.filter((file) => applicationSliceOf(file.path));
    expect(files.length).toBeGreaterThan(50);
    expect(applicationSliceOf("src/application/errors.ts")).toBe("errors");
    expect(applicationSliceOf("@/application/execution/runProject")).toBe("execution");
  });
});

/**
 * An optional field on `ExecutionDeps` is how a feature is off — and how a
 * forgotten wire looks exactly like a feature that is off. That shape has bitten
 * before: `resolveRunTools` took its discovery queries as an optional argument,
 * two call sites omitted them, and a version's `dynamicCapabilities` read as on
 * while the search never ran (`TOOL_RESOLUTION_SITES` is the patch over that
 * instance). `mcpConnections` is the same shape today — absent, discovery
 * treats every OAuth server as unconnected, silently.
 *
 * The composition root is the only production builder of the bag, so the rule
 * is checkable there: every optional field must be *named* in `container.ts` —
 * a conditional spread (`...(x ? { catalog: … } : {})`) still names it, which
 * is exactly the distinction wanted. "This deployment turned it off" appears in
 * the source; "nobody thought about it" does not.
 *
 * Only `ExecutionDeps`' own declaration block is parsed; fields inherited from
 * `RunBracketDeps` arrive through an intersection this regex cannot see, and
 * each of those is exercised by the run-bracket tests instead.
 */
describe("execution deps wiring", () => {
  it("the composition root decides every optional field by name", () => {
    // Both halves of the bag: `ExecutionDeps` extends `RunBracketDeps`, so a
    // field declared on the bracket is just as optional at the wiring site and
    // just as invisible when it is forgotten. `artifacts` is one — a run with no
    // object storage and a run whose storage nobody wired look identical from
    // inside, which is the failure this whole check exists for.
    const declarations: Array<[string, RegExp]> = [
      ["src/application/execution/deps.ts", /export interface ExecutionDeps[^{]*\{([\s\S]*?)\n\}/],
      ["src/application/run/runBracket.ts", /export type RunBracketDeps[^{]*\{([\s\S]*?)\n\s*\};/],
    ];
    const optional = declarations.flatMap(([path, blockPattern]) => {
      const file = SOURCE_FILES.find((f) => f.path === path);
      const block = blockPattern.exec(stripComments(file?.text ?? ""))?.[1] ?? "";
      return [...block.matchAll(/^\s{2,4}(\w+)\?:/gm)].map((match) => match[1]!);
    });
    // The two test seams: a production root must never pin the clock or the
    // sampling draw, so their absence from container.ts is the correct state.
    const seams = new Set(["now", "sample"]);
    // A regression in either interface regex would empty `optional` and read as
    // a clean pass; the fields this exists for anchor it.
    expect(optional).toContain("catalog");
    expect(optional).toContain("mcpConnections");
    expect(optional).toContain("artifacts");
    const container = stripComments(
      SOURCE_FILES.find((file) => file.path === "src/lib/container.ts")?.text ?? "",
    );
    // Per bag, not per file. Asking whether each name appears *anywhere* in
    // container.ts passed while `imageDeps` was a second literal missing nothing
    // yet — and the next policy added to the bracket would have reached one bag
    // and not the other, silently, with this test green. A bag that is an alias
    // (`= executionDeps`) declares no fields and is not a bag: only object
    // literals are checked, which is what makes collapsing the copy the fix
    // rather than a way around the rule.
    const bags = [
      ...container.matchAll(
        /export const (\w+): (?:ExecutionDeps|ImageGenerationDeps|RunBracketDeps)\s*=\s*\{([\s\S]*?)\n\};/g,
      ),
    ].map((match) => ({ name: match[1]!, body: match[2]! }));
    expect(bags.length).toBeGreaterThan(0);
    const unwired = bags.flatMap((bag) =>
      optional
        .filter((name) => !seams.has(name) && !new RegExp(`\\b${name}:`).test(bag.body))
        .map((name) => `${bag.name}.${name}`),
    );
    expect(unwired).toEqual([]);
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
    // Written once for the artifacts gallery, then wanted verbatim by the chat's
    // download row the moment files became deliverable — which is how the second
    // copy of anything starts. Two surfaces looking at the same object have to
    // report the same number in the same units: `1.5 MB` in a transcript beside
    // `1,605,516 bytes` in the gallery reads as two different files.
    what: "a stored object's size, written for a person",
    pattern: /const units = \["KB", "MB", "GB"\]/,
    owner: "src/app/_lib/formatBytes.ts",
  },
  {
    what: "the shape of an MCP tool",
    pattern: /^export interface McpTool\b/m,
    owner: "src/domain/mcp/types.ts",
  },
  {
    // The one place drift is fatal by specification rather than by consequence:
    // an authorization server rejects the authorization outright when the
    // `client_id` *inside* a metadata document differs from the URL it fetched
    // the document from. Three sites want to build that address — the document
    // route, the connection that presents it, and whatever renders it next — so
    // the source comment already argues the rule; without this it was argued and
    // not fixed, which is the failure the convention names.
    what: "the address a project's client ID metadata document is served at",
    pattern: /MCP_CLIENT_METADATA_PATH\}\/\$\{projectName\}/,
    owner: "src/application/mcp/mcpAuthUseCases.ts",
  },
  {
    // The two ways an MCP entry reaches an address the SSRF guard rejects:
    // provenance (we started the container) and declaration (an operator put the
    // host's suffix in this deployment's configuration). Six call sites ask —
    // registration, update, the console's two probes, the OAuth metadata read,
    // and dispatch — and a seventh that answered for itself would be a hole in
    // the outbound boundary rather than a duplicated constant. The declaration
    // half is one predicate over two lists — the MCP list and the FetchUrl list
    // — so it sits in a neutral domain module rather than with `skipsUrlGuard`.
    // The pattern matches the suffix match itself, which is the part a copy
    // would get subtly wrong.
    what: "which hosts may skip the outbound URL guard",
    pattern: /endsWith\(`\.\$\{/,
    owner: "src/domain/security/internalHosts.ts",
  },
  {
    // Every recorded act goes through it, and each is the kind of code written once and read
    // years later. A second writer would spell `target` its own way, and a
    // filter that worked for reveals would silently return nothing for
    // deletions — the failure being invisible is the whole problem with an
    // audit trail that has drifted.
    what: "how an audit row is written",
    pattern: /const event: AuditEvent = \{/,
    owner: "src/application/audit/recordAudit.ts",
  },
  {
    // The sentence that tells a model the text it is about to read is data.
    // It shares that sentence with `framedDocument`, which is why the two live
    // in one file: a page off the open web is if anything likelier to contain
    // something shaped like an instruction than a file someone attached.
    what: "how a fetched URL is framed in a turn",
    pattern: /\[Fetched from /,
    owner: "src/application/llm/documentParts.ts",
  },
  {
    // Deliberately far above the attachment budget and far below nothing at
    // all; `documentLimits.ts` explains the asymmetry, and a second copy of
    // this number would quietly make one of those two comments false.
    what: "how much of a fetched URL is kept",
    pattern: /MAX_FETCHED_TEXT_CHARS =/,
    owner: "src/application/llm/urlContent.ts",
  },
  {
    // Every stored byte goes through it — a generated image, a rendered
    // document, an attachment. A second writer would spell the provenance its
    // own way, and a gallery filtering on it would show nothing for half the
    // rows without anything looking broken.
    what: "how an artifact row is written",
    pattern: /const artifact: Artifact = \{/,
    owner: "src/application/artifact/storeArtifact.ts",
  },
  {
    // The key is derived from the row's id, which is the only reason an object
    // and its row can find each other — the legacy `images/<uuid>` layout
    // referenced nothing, so an orphan could never be identified again. A second
    // site composing this prefix would be free to disagree about the kind
    // segment, and an S3 lifecycle rule applies to exactly that prefix.
    what: "the object key an artifact is stored under",
    pattern: /`artifacts\/\$\{/,
    owner: "src/domain/artifact/types.ts",
  },
  {
    // The app's only deletion of stored bytes. Deleting an object is the half of
    // an artifact delete that cannot be undone, and the order it happens in
    // relative to the row is what makes a retry converge; a second caller would
    // be free to get that order backwards.
    what: "deleting a stored object",
    pattern: /DeleteObjectCommand/,
    owner: "src/infrastructure/storage/s3ObjectStore.ts",
  },
  {
    // The address a proxied object is reached at and the token that opens it
    // are one format: the route parses exactly what the signer wrote, and a
    // second writer of either would be free to disagree about what the HMAC
    // covers — which is a link that stops answering, or one that answers
    // with a filename it was not signed for.
    what: "the proxied object URL and its token",
    pattern: /"\/api\/objects"/,
    owner: "src/infrastructure/storage/objectUrlToken.ts",
  },
  {
    what: "which storage errors mean a lost conditional write",
    pattern: /"ConditionalWriteFailed"/,
    owner: "src/application/errors.ts",
    // The store raises it; only the application layer must not re-derive it.
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
    // Every optional env read spelled this `|| undefined`, and whitespace went
    // through all of them: a secret mounted from a file carries a trailing
    // newline, so `A2A_API_KEY=" "` passed the boot guard, showed as
    // `source: "env"` on the settings page, and 401'd every request. A second
    // copy is how the page and the runtime end up disagreeing about whether a
    // variable is set — which is the direction the bug already ran, since an
    // override is stored trimmed and the environment was not.
    what: "whether a configured value is blank",
    pattern: /\?\.trim\(\) \|\| undefined/,
    owner: "src/shared/env.ts",
  },
  {
    // Two callers embed: a reindex, and a run's discovery. Both have to produce
    // vectors in the same space as the index they are compared against, which
    // means the same model *and* the same encoding — a second call site taking
    // the SDK's base64 default would decode into empty vectors and rank
    // everything identically, with no error raised anywhere.
    what: "asking a provider for an embedding",
    pattern: /embeddings\.create\(/,
    owner: "src/infrastructure/llm/embeddings.ts",
  },
  {
    // Two adapters invoke Bedrock — Titan and Cohere — and they differ only in
    // the body they send. Reaching the service is one question with one answer
    // (which region, and that the pod's credentials come from its Pod Identity
    // association rather than a key), so the client is built once.
    what: "talking to Bedrock",
    pattern: /new BedrockRuntimeClient\(/,
    owner: "src/infrastructure/llm/bedrockClient.ts",
  },
  {
    // One place knows that an index fixes its dimension and its distance
    // metric. A second construction site is how a store ends up queried under a
    // metric it was not built with, which surfaces only as a ranking that is
    // subtly wrong.
    what: "talking to the vector store",
    pattern: /embedding <=>/,
    owner: "src/infrastructure/vector/pgVectorStore.ts",
  },
  {
    // A reindex derives this key to write an entry, and deletes whatever it did
    // not derive. A second spelling would therefore orphan every entry of one
    // kind on the first tick after it appeared — the index would look healthy
    // and answer nothing.
    what: "the key a capability is indexed under",
    pattern: /export function capabilityKey/,
    owner: "src/domain/catalog/types.ts",
  },
  {
    // What a capability is embedded as. A second composition site would embed
    // one kind under different text than the reindex wrote, and the drift shows
    // up only as retrieval quality nobody can attribute.
    what: "what text a capability is embedded as",
    pattern: /export function capabilityText/,
    owner: "src/domain/catalog/types.ts",
  },
  {
    // How much a search may add to one run. A second copy of the limits is a
    // second answer to how large a discovered prompt may grow.
    what: "how much a search may add to one run",
    pattern: /const DISCOVERY_LIMITS = \{/,
    owner: "src/application/execution/bindings.ts",
  },
  {
    // What a run searches the catalog with. The three resolution sites below
    // (`TOOL_RESOLUTION_SITES`) must call this rather than compose their own
    // queries — a second composition is a second opinion on what a run asked.
    what: "what a run searches the catalog with",
    pattern: /export function discoveryQueries/,
    owner: "src/application/execution/bindings.ts",
  },
  {
    // One spelling of the header that names the calling project to an MCP
    // server. A second literal is how a probe and a run end up presenting
    // different tenants to the same server.
    what: "the header that names the calling project to an MCP server",
    pattern: /"X-Tenant-Id"/,
    owner: "src/application/execution/mcpTools.ts",
  },
  {
    // Its sibling: the header that names the run's conversation to an MCP
    // server. The API layer reads the same spelling *inbound* — a caller's own
    // `X-Conversation-Id` — and that is one file by design, so a caller can
    // follow its id through; it is exempted by path rather than by layer so no
    // route handler grows a third.
    what: "the header that names the run's conversation to an MCP server",
    pattern: /"X-Conversation-Id"/,
    owner: "src/application/execution/mcpTools.ts",
    // The API Reference tab *shows* the inbound spelling to a caller; it is a
    // client module and cannot import the route helper that owns it.
    alsoAllowedUnder: [
      "src/app/api/projects/_lib/conversation.ts",
      "src/app/projects/[name]/api-reference/endpoints.ts",
    ],
  },
  {
    // What a Slack message says — its text, its attachments and its prose
    // blocks read as one. Three readers (the keyword match, the turn a run
    // answers, the thread history) have to agree, or a keyword fires on an
    // alert whose body the run then never sees.
    what: "what a Slack message says",
    pattern: /export function slackMessageText/,
    owner: "src/domain/slack/messageText.ts",
  },
  {
    // How a run primes its memory: which tool is asked, with what, and what the
    // answer becomes. Two run sites (the facade and the local subagent) call it;
    // a site with its own recall would ask a different question of the same
    // server, or put the answer somewhere the preview does not know about.
    what: "how a run primes its memory",
    pattern: /export async function recallMemories/,
    owner: "src/application/execution/memoryRecall.ts",
  },
  {
    // How a conversation is built from a surface's id and spelled as a key.
    // Every surface has its own builder (`chatConversation`,
    // `slackConversation`, `telegramConversation`, `a2aConversation`,
    // `requestConversation`), and each goes through these two — a surface normalising or spelling its own would
    // present a memory server with a key nothing else can match.
    what: "how a run's conversation is built and keyed",
    pattern: /export function conversation(?:Of|Key)\b/,
    owner: "src/domain/execution/actor.ts",
  },
  {
    // A listing's page cursor *is* the row's sort key, and the two halves of
    // that fact were written apart: the adapter built the string to compare a
    // row against an incoming `before`, and the route answering a page built it
    // again to hand the reader the next one. Exclusion is by string equality, so
    // a change to either spelling breaks paging by repeating or skipping a row
    // rather than by failing.
    what: "how an artifact listing's page cursor is spelled",
    pattern: /createdAt\}#\$\{[\w.]*artifactId\}/,
    owner: "src/domain/artifact/repository.ts",
  },
  {
    // The plugins sync reads a frontmatter block from two document kinds —
    // SKILL.md and the MCP extension documents — and a second parser would let
    // the same document mean different things depending on which kind it came
    // in as. The pattern matches the delimiter regex, which is where a copy
    // starts.
    what: "parsing a markdown frontmatter block",
    pattern: /\^---\\r\?\\n/,
    owner: "src/domain/plugin/frontmatter.ts",
  },
  {
    // A repo-owned component's provenance — `github:<repo>#<plugin>` — had a
    // reader in the domain and a writer in the sync, joined only by a comment
    // asking whoever changed one to remember the other. A prefix that lost its
    // `#` fails nothing: the sync adopts rows it does not own and the console
    // stops calling them repo-owned.
    what: "the provenance string a repo-owned component carries",
    pattern: /github:\$\{|"github:"/,
    owner: "src/domain/plugin/types.ts",
  },
  {
    // The Agent Plugins spec's name rule, which is deliberately not `isSlug`
    // (periods are legal). The pattern matches the lookahead that encodes the
    // no-`--`/no-`..` clause — the part a re-spelling would get subtly wrong.
    what: "the Agent Plugins name rule",
    pattern: /\(\?!\.\*\(\?:--\|\\\.\\\.\)\)/,
    owner: "src/domain/plugin/types.ts",
  },
  {
    // Which mcp.json transports this deployment binds. The sync acts on
    // `classifyMcpJsonServer` and never inspects a `type` literal itself — a
    // second site testing the literal is a second transport policy.
    what: "which MCP transports a plugin may bind",
    pattern: /"streamable-http"/,
    owner: "src/domain/plugin/types.ts",
  },
  {
    what: "the subagent nesting limit",
    pattern: /MAX_SUBAGENT_DEPTH\s*=/,
    owner: "src/application/execution/subagentRunner.ts",
  },
  {
    what: "the per-run MCP tool cap",
    pattern: /MAX_MCP_TOOLS_PER_RUN\s*=/,
    owner: "src/domain/llm/toolLimits.ts",
  },
  {
    // Two mechanisms spend these — the concurrency guard in `run` and the
    // member cost guard in `usage` — and the Members console displays them, so
    // the table lives in domain where all three may import it. A copy beside
    // either guard would recreate the drift the table exists to prevent.
    what: "what each member tier may spend",
    pattern: /TIER_LIMITS\s*:\s*Record<MemberTier/,
    owner: "src/domain/member/tiers.ts",
  },
  {
    what: "how many agents one dispatch may run",
    pattern: /MAX_DISPATCH_TASKS\s*=/,
    owner: "src/application/llm/agentAssembly.ts",
  },
  {
    // Two surfaces ask the same question — the chat store about the answer it
    // is about to re-render, the console about the thinking it is about to
    // commit — and each had grown its own copy of the three constants and the
    // formula over them. Retuning one then leaves the other on the old curve,
    // which is invisible: both still feel "about right".
    what: "how long to collect streamed text before drawing it",
    pattern: /CHARS_PER_EXTRA_MS\s*=/,
    owner: "src/app/_lib/textPacer.ts",
  },
  {
    // Where the subtleties of a hand-rolled merge live: exactly one in-flight
    // `next()` per source, return values kept at their own index rather than in
    // arrival order, and closing that is deliberately never awaited. A second
    // copy gets one of those three wrong.
    what: "merging concurrent generators",
    pattern: /IteratorResult</,
    owner: "src/shared/mergeGenerators.ts",
    // `detachOnReturn` hand-rolls an iterator for the same reason this one does
    // — `return()` cannot reach a generator parked at an `await` — so it spells
    // the type out too. It merges nothing; the shared token is generator
    // plumbing, not a second copy of the merge.
    alsoAllowedUnder: ["src/shared/detachOnReturn.ts"],
  },
  {
    // The protocol's lifecycle — a run opened, closed or failed — is emitted by
    // the one translator that also knows what is still open when it ends (a
    // text message, a reasoning block, a subagent's step). A second emitter
    // would close none of those, and a client rejects a run that finishes
    // with a message still open. The domain declares the shapes with a
    // semicolon; this matches the object literal a producer writes.
    what: "emitting an AG-UI run's lifecycle events",
    pattern: /type: "RUN_(STARTED|FINISHED|ERROR)",/,
    owner: "src/application/agui/events.ts",
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
      "src/app/api/chats/_lib/frames.ts",
      "src/application/chat/run.ts",
      "src/shared/mergeGenerators.ts",
      "src/shared/detachOnReturn.ts",
      "src/infrastructure/slack/profileCache.ts",
    ],
  },
  {
    // Seven consumers each decided which warning chunks count toward a run's
    // collected losses, and they had split three ways: two kept only top-level
    // warnings — dropping every loss a subagent reported — and three repeated
    // what the reader had already been told. `collectedWarning` owns the
    // decision. The exempt files relay individual warning chunks onward (a
    // wire delta, a sampled trace preview, a run-log note) rather than
    // collecting the run's list, so the collection decision never comes up.
    what: "collecting what a run lost from its chunks",
    pattern: /chunk\.warning/,
    owner: "src/domain/llm/types.ts",
    alsoAllowedUnder: [
      "src/app/api/projects/_lib/openai.ts",
      "src/application/trace/recorder.ts",
      "src/application/chat/run.ts",
    ],
  },
  {
    // The builders each had one owner; the *arguments* did not. `runAgent` and
    // the Playground preview spelled out eight and seven positional arguments
    // apiece, and had already drifted — the preview omitted the eighth, so a
    // version that opted into `callerContext` previewed a prompt one block
    // short of what every real run sends. `assembleAgentRun` is the one caller
    // now, and a second one fails here.
    what: "how an agent run's prompt and tool set are assembled",
    pattern: /build(?:AgentSystemPrompt|AgentTools)\(\{/,
    owner: "src/application/llm/agentAssembly.ts",
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
    owner: "src/domain/naming.ts",
  },
  {
    // The stricter sibling: a slug that must also be a DNS label, because it
    // names a Docker container and an SSM parameter path. The create route,
    // both provisioners and the console form each spelled it out.
    what: "the managed-workload name rule",
    pattern: /\[a-z0-9\]\[a-z0-9-\]\{0,62\}/,
    owner: "src/domain/naming.ts",
  },
  {
    what: "user-document caps",
    pattern: /MAX_DOCUMENT_CHARS_PER_TURN =/,
    owner: "src/domain/llm/documentLimits.ts",
  },
  {
    // Every other bound is per item or per turn; this is the one that knows the
    // sum a run may accumulate, derived from the model's context window. The
    // pattern matches reading `.contextWindow` — a second derivation starts by
    // reading the window somewhere else, with its own chars-per-token guess.
    what: "deriving a run's context budget from the model's window",
    pattern: /\.contextWindow\b/,
    owner: "src/application/llm/contextBudget.ts",
    // The registry reads the field to *assemble* it: a model's window is stated
    // by its family and may be narrowed by one route, so deriving an entry
    // touches the name. That is the value's origin, not a second budget — the
    // thing this rule exists to keep single is the chars-per-token derivation.
    //
    // Self-hosted declarations make the deployment a publisher too, and a
    // publisher *states* the window rather than deriving from it: the console
    // section edits the number, and the discovery adapter carries what the
    // serving stack reports. Transport of the value's origin, like models.ts.
    alsoAllowedUnder: [
      "src/domain/llm/models.ts",
      "src/domain/llm/selfHostedModels.ts",
      "src/app/models/page.tsx",
      "src/infrastructure/llm/selfHostedDiscovery.ts",
    ],
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
    alsoAllowedUnder: [
      // The API-reference page ships a Node.js SDK sample *containing* a
      // `console.log` call. It is text shown to a user, not a call this app
      // makes.
      "src/app/projects/[name]/api-reference/",
      // The error boundaries, for the same reason `domain` is exempt: they
      // cannot reach the owner. `logger.ts` imports `node:async_hooks` for the
      // run correlation id, which no browser has — and a boundary that caught
      // a client-side render throw is the one failure with no server log line
      // and often no digest either, so writing nothing would leave an operator
      // with no record of it at all.
      "src/app/_components/ErrorCard.tsx",
      "src/app/global-error.tsx",
    ],
  },
  {
    // Four functions admit a top-level run, and each used to open the in-flight
    // metric for itself — which is exactly why the daily cost guard had four
    // places it could have been forgotten. `openRun` is now the one bracket, so
    // a fifth entry point that skips it is missing its metric too, and that is
    // what this catches. The pattern matches the *call*, not the definition in
    // `lib/runMetrics.ts`.
    what: "what wraps a top-level run",
    pattern: /^\s*(?:const\s+\w+\s*=\s*)?beginRun\([^)]*\);/m,
    owner: "src/application/run/runBracket.ts",
  },
  {
    // The version path and the image path each derived this, with opposite
    // comparison operators — one rejected on `>= rate`, the other accepted on
    // `< rate`. The pattern matches the rate fallback, which is where a copy
    // starts.
    what: "whether a run's trace is sampled",
    pattern: /traceSampleRate \?\?/,
    owner: "src/application/run/traceLifecycle.ts",
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
    // The console shows it, the API reference documents it, and the route
    // serves it. A URL a person copies out of one surface and a URL another
    // surface built by hand are the same string right up until one of them
    // moves, and the failure is a sender that 404s with nothing to read.
    what: "where a project's webhook is delivered",
    // The interpolation, not the prose: several files name the path in a
    // comment, and only one may *build* it.
    pattern: /`\/api\/webhook\/\$\{/,
    owner: "src/domain/trigger/types.ts",
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
    // With `message.channels` subscribed the bot receives its own replies, and
    // a reply lands in a thread the bot is engaged in — so a second copy of
    // this check that drifted would not merely answer something twice, it would
    // answer itself without end. The handler used to carry its own copy, after
    // the dedup claim, where it could no longer prevent the loop it names.
    what: "whether a Slack event is the bot talking to itself",
    pattern: /authorizations\?\.find/,
    owner: "src/application/slack/engagement.ts",
  },
  {
    // Which delivered events cause a run. The gate has to stay ahead of the
    // dedup claim — that ordering is what keeps an ignored channel message from
    // costing a write — so a surface that re-decided it downstream would be
    // paying for a decision already made.
    what: "which Slack events are for the bot",
    pattern: /export function classifySlackEvent/,
    owner: "src/application/slack/engagement.ts",
  },
  {
    // A command changes whether the bot speaks again, so a second, looser match
    // would silence threads nobody asked to silence — and silently, because the
    // symptom is a bot that stopped answering rather than one that errored.
    what: "which Slack messages are a fixed command rather than a question",
    pattern: /export function parseSlackCommand/,
    owner: "src/application/slack/engagement.ts",
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
  {
    // What a tool result has to do, and the order it has to happen in: mask,
    // charge, show the restored text, store the masked one. Eleven branches of
    // the dispatch loop spelled it out and five of them skipped the charge. A
    // branch that stored the *restored* text would put back exactly what
    // `piiFiltering` removed, for one tool, silently. Scoped to the engine
    // because chat replay legitimately builds `role: "tool"` messages from
    // stored rows — that is reconstruction, not dispatch.
    what: "what a tool result has to do, and in what order",
    pattern: /tool_call_id: call\.id/,
    owner: "src/application/llm/toolResultBudget.ts",
    within: "src/application/llm/",
  },
  {
    // Whether a run's prompt may name the person asking. Three modules answered
    // it — the two runners and the Playground preview — and the preview's copy
    // ran on one of its two branches, so a prompt project previewed anonymously
    // however its version was configured. The pattern matches the conjunction,
    // which is what a copy of the gate looks like; Slack's separate
    // `parameters.callerContext ? …` is a different question (whether to make
    // the profile lookup at all) and is deliberately not matched.
    what: "whether a run's prompt may name its caller",
    pattern: /callerContext && /,
    owner: "src/application/execution/deps.ts",
  },
  {
    // Two sides have to agree on this string and they sit in different layers:
    // `lib/auth.ts` throws it and `/login` reads it back off the query string,
    // with Better Auth's redirect in between. Either one spelling it inline is
    // a refusal that silently stops explaining itself. Quoted, so importing the
    // constant is not mistaken for writing a second one.
    what: "the code a refused sign-in is identified by",
    pattern: /"EMAIL_DOMAIN_NOT_ALLOWED"/,
    owner: "src/shared/signInError.ts",
  },
  {
    // A 401 asks for something no other MCP failure does — the *project* must
    // reconnect, rather than an operator going to look at the server — and three
    // places have to tell them apart: discovery, a tool call made against a
    // session the discovery cache let through uninitialized, and the registry's
    // probe. Each spelled the pair out for itself, which is how the third one
    // came to exist without anyone deciding it should.
    what: "what a 401 from an MCP server means",
    pattern: /McpHttpError && \w+\.status === 401/,
    owner: "src/infrastructure/mcp/session.ts",
  },
  {
    // MCP allows a tool name a provider's function name does not (128 characters
    // and a dot, against `[A-Za-z0-9_-]{1,64}`), so the name is normalised into
    // one the provider accepts and the alias mapping keeps the server's own. A
    // second normaliser would disagree about the substitute character or the
    // cut, and the two names would stop addressing the same tool. The pattern is
    // the character class, which is the half a copy gets subtly wrong.
    what: "the name a provider will accept for an MCP tool",
    pattern: /\[\^A-Za-z0-9_-\]/,
    owner: "src/infrastructure/mcp/toolManager.ts",
  },
  {
    // What every chat-bot surface does with a run once its adapter has said who
    // is asking and where the answer goes: attachments into a turn, chunks onto
    // the sink, the tail in one order. Slack had it inline and Telegram would
    // have been the second copy — of exactly the fold whose image and file axes
    // had already drifted apart across six other consumers. A tool result is
    // the one boundary that ticks a step off, so this call is the pipeline's.
    what: "how a chat-bot turn runs once its adapter has normalised it",
    pattern: /\.stepDone\(/,
    owner: "src/application/messaging/handleTurn.ts",
  },
  {
    // The limits and the sentence each dropped attachment earns, once for every
    // chat platform: a surface that reported "read only 3 of 5" differently
    // from its sibling would be two products in one reply.
    what: "attachment limits and warnings for a chat-bot turn",
    pattern: /Read only \$\{budget\} of/,
    owner: "src/application/messaging/attachments.ts",
  },
  {
    // The ports every chat-bot adapter renders. Domain, so the pipeline and the
    // adapters name it without importing each other; one definition, so a sink
    // and the channel around it cannot drift into two vocabularies.
    what: "the reply ports every chat-bot surface implements",
    pattern: /interface ReplyChannel/,
    owner: "src/domain/messaging/reply.ts",
  },
  {
    // One conditional put and one conditional update, keyed however the
    // platform's events are. Slack's version was written before Telegram's; a
    // second copy of the lease condition is the seven spellings of the
    // conditional-write error name again.
    what: "the claim-and-settle contract behind exactly-once inbound events",
    pattern: /leaseExpiresAt \?\? 0\) < nowSeconds/,
    owner: "src/infrastructure/db/repositories/inboundClaimRepository.ts",
  },
  {
    // The webhook tail: claim, ack, work in the background under the event's
    // id, settle. Every platform requires the same shape and each writing its
    // own is how one of them forgets to settle.
    what: "the webhook tail every chat platform shares",
    pattern: /\.settle\(eventId, outcome\)/,
    owner: "src/app/api/_lib/inboundEvent.ts",
  },
  {
    // Telegram has one way to put a growing answer on screen — send, then edit
    // — and one message holds 4,096 characters. A second Telegram entry point
    // that edited for itself is a second copy of the pacing, the split and the
    // rendered-then-plain fallback. The pattern matches the edit *call*, not
    // the port method or the adapter that implements it.
    what: "how a Telegram reply is delivered",
    pattern: /telegram\.editMessageText\(/,
    owner: "src/application/telegram/replyChannel.ts",
  },
  {
    // Which delivered updates cause a run. Ahead of the dedup claim, like
    // Slack's, and for the same reason.
    what: "which Telegram updates are for the bot",
    pattern: /export function classifyTelegramUpdate/,
    owner: "src/application/telegram/engagement.ts",
  },
  {
    // The Bot API slice this platform uses; three modules take it and the
    // adapter implements it.
    what: "the Telegram Bot API surface this platform uses",
    pattern: /interface TelegramClientPort/,
    owner: "src/domain/telegram/client.ts",
  },
  {
    // Telegram renders HTML strictly and refuses a whole message over one bad
    // tag, so what an answer's Markdown becomes is decided once, and the reply
    // channel falls back to plain text when the decision was wrong.
    what: "rendering an answer's Markdown as Telegram HTML",
    pattern: /export function markdownToTelegramHtml/,
    owner: "src/application/telegram/markdown.ts",
  },
  {
    // Two surfaces deliver a reply by sending a message and editing it, and
    // the bookkeeping — pacing, the cut into the next message, what a refused
    // write does to the next one, what the close owes when a write fails — is
    // the part that goes wrong. Telegram wrote it; Teams takes it. A second
    // copy of the refused-write backoff is a second copy of every one of those.
    what: "the edit-in-place reply bookkeeping",
    pattern: /refusedAt/,
    owner: "src/application/messaging/editInPlaceReply.ts",
  },
  {
    // Three surfaces cut an answer that outgrew one message, and only their
    // caps differ. Where the cut lands is what a reader sees — a second copy is
    // a second answer to "does this stop mid-sentence", which is the whole
    // question. Slack learned it late: its edited path had no cap at all, so
    // the cut was wherever the last accepted write happened to end.
    what: "where a reply is cut when it outgrows one message",
    pattern: /export function cutPoint/,
    owner: "src/shared/messageCut.ts",
  },
  {
    // What a surface with no platform history remembers of a conversation:
    // read within a budget, written bounded, names read only for a version
    // still opted in. Two surfaces need it identically; the drop sentence is
    // the pattern because it is the half a copy would spell differently.
    what: "how a chat bot with no platform history reads and writes its transcript",
    pattern: /Older conversation turns were left out/,
    owner: "src/application/messaging/transcriptHistory.ts",
  },
  {
    // The Bot Framework has one way to put an answer on screen — send an
    // activity, then update it — and a second Teams entry point that updated
    // for itself is a second copy of the transport. The pattern is the update
    // *call*, not the port method or the adapter.
    what: "how a Teams reply is delivered",
    pattern: /teams\.updateActivity\(/,
    owner: "src/application/teams/replyChannel.ts",
  },
  {
    // Which delivered activities cause a run. Ahead of the dedup claim, like
    // Slack's and Telegram's, and for the same reason.
    what: "which Teams activities are for the bot",
    pattern: /export function classifyTeamsActivity/,
    owner: "src/application/teams/engagement.ts",
  },
  {
    // The Bot Framework slice this platform uses; three modules take it and the
    // adapter implements it.
    what: "the Bot Framework surface this platform uses",
    pattern: /interface TeamsClientPort/,
    owner: "src/domain/teams/client.ts",
  },
  {
    // Everything the Teams endpoint trusts rests on one check: the token's
    // signature against the service's published keys, its issuer, its
    // audience, and the serviceUrl it was issued for. A second copy of the
    // key fetch is a second place the check can be wrong.
    what: "verifying a Bot Framework token",
    pattern: /login\.botframework\.com/,
    owner: "src/infrastructure/teams/client.ts",
  },
  {
    // What a surface with no platform history does around the turn: read what
    // it remembers, run, write both turns down at the arrival instant. Two
    // handlers carried it verbatim, comments included; the third would too.
    what: "the turn a chat bot with no platform history runs",
    pattern: /export async function runRememberedTurn/,
    owner: "src/application/messaging/rememberedTurn.ts",
  },
  {
    // Whether a fence is open has to be answered the way the renderer reads
    // fences — anywhere, not at line starts — or a piece boundary and a tail
    // disagree with the message the reader sees. One reading.
    what: "whether a Markdown fence is open",
    pattern: /export function openFenceAfter/,
    owner: "src/shared/markdownFence.ts",
  },
  {
    // Not a duplicated definition but a duplicated *copy of undici*, which is
    // the same failure one layer down. A `dispatcher` is a private contract
    // between a fetch implementation and its `Agent`, and the runtime ships its
    // own undici behind the global `fetch` — so the package may only be reached
    // where both halves are taken from it together. Mixing them cost every
    // outbound request a bare `TypeError: fetch failed` on a Node whose bundled
    // major had drifted from `package.json`, with the real reason
    // (`invalid onRequestStart method`) buried in a `cause` nothing logged.
    what: "reaching undici directly",
    pattern: /from "undici"/,
    owner: "src/infrastructure/net/publicFetch.ts",
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
 * The other half of `formatUsd`'s single-owner claim, which the check above
 * cannot make: a copy does not repeat the *definition*, it hand-rolls a
 * different one. `$${value.toFixed(4)}` is what three cost tables and a compare
 * badge actually wrote, and it disagrees with the owner in two ways at once —
 * no thousands separator, and a fixed width that reports `$0.00` for the
 * sub-cent amounts a cost page exists to show. So the rule is spelled as the
 * shape of the mistake rather than the shape of the definition.
 *
 * Scoped to `app` because that is exactly where the owner is reachable. The
 * cost guards format dollars into a 429 message and a messaging alert, and they
 * live in `application`, which may not import `@/app` — their amounts are
 * sentences for a caller, not columns for a reader, and the dependency rule is
 * what keeps the two apart.
 *
 * `formatBytes` is exempt by name rather than by pattern: the two `_lib`
 * formatters are each the owner of their own format, and a byte count's
 * `toFixed(1)` is indistinguishable from a dollar's in source text — the `${`
 * of a template literal and the `$` + `{expr}` of JSX read the same.
 */
describe("a dollar amount is never written by hand", () => {
  it("has no `$` followed by a rounded number in app outside formatUsd", () => {
    const formatters = ["src/app/_lib/formatUsd.ts", "src/app/_lib/formatBytes.ts"];
    const handRolled = SOURCE_FILES.filter(
      (file) =>
        layerOf(file.path) === "app" &&
        !formatters.includes(file.path) &&
        /\$\{[^}]*\.toFixed\(/.test(stripComments(file.text)),
    ).map((file) => file.path);
    expect(handRolled).toEqual([]);
  });
});

/**
 * Who may start an image run.
 *
 * The image use case is the one execution path the facade deliberately does not
 * absorb — `/chat/completions` depends on an image project being *refused*, and
 * a flag deciding whether a project type is refused is the bug that refusal
 * prevents. The cost of that decision is that more than one surface reaches the
 * use case directly, and each brings its own serialisation: JSON with the
 * model and usage, an A2A file artifact, a chunk stream.
 *
 * So the list is bounded rather than owned. Three entries, each because it
 * answers in a shape no other one can, and a fourth has to be added here on
 * purpose — which is the check the four-copy version of this dispatch never had.
 * A surface that only needs chunks belongs behind `streamProjectRun`; that is
 * what the composition root's own copy became.
 */
const IMAGE_RUN_ENTRY_POINTS = [
  // Answers with chunks, for every consumer that reads a run generically.
  "src/application/execution/runProject.ts",
  // Answers with `{ imageBase64, model, usage }`, which no chunk stream carries.
  "src/app/api/projects/[name]/versions/[version]/predict/route.ts",
  // Answers with an `image` artifact — an id A2A clients already read.
  "src/application/a2a/executor.ts",
];

describe("image runs", () => {
  it("start at the entry points that declare themselves here", () => {
    const callers = SOURCE_FILES.filter((file) =>
      parseImports(file.text).some(
        (i) => resolveSpec(i.spec, file.path) === "@/application/image/generateImage" && !i.typeOnly,
      ),
    ).map((file) => file.path);
    expect(callers.sort()).toEqual([...IMAGE_RUN_ENTRY_POINTS].sort());
  });
});

/**
 * Who keeps what a run produced.
 *
 * Four functions admit a top-level run and every one of them can produce bytes,
 * so the recorder is built by the bracket they all open — the same seam the cost
 * and concurrency guards use, and for the same reason. Attaching it to
 * `generateImage` instead would have covered a quarter of the cases: an image
 * reaches the stream from four producers (an image project, the
 * GenerateImage/EditImage builtins, an image subagent, an MCP tool that returned
 * one) and only the first is that use case.
 *
 * The second assertion is the load-bearing one. A fifth entry point that opens a
 * bracket and never captures would drop its output silently — the run works, the
 * gallery is simply missing it — which is exactly the failure that made the
 * original chat-only storage invisible for years.
 */
const ARTIFACT_CAPTURE_SITES = [
  // Builds the recorder, with the run's identity bound once.
  "src/application/run/runBracket.ts",
  // Wraps the agent stream, where every producer's bytes converge.
  "src/application/execution/runProject.ts",
  // `generateImage.ts` is deliberately absent: it records the single result an
  // image project answers with, but reaches it through `bracket.artifacts`
  // rather than importing the module. The bracket check below is what holds it.
];

/**
 * The one place an address the *model* chose is fetched.
 *
 * `fetchPublicUrl` was built as the second of two controls: `docs/SECURITY.md`
 * describes the registration check as the first, and the dispatch check as
 * narrowing — not closing — the window between them. A URL a model named has no
 * first control at all, so this adapter is the whole defence.
 *
 * The MCP internal-host exemption is the specific thing that must never reach
 * it. `skipsUrlGuard` exists so this app can talk to its own cluster MCP
 * services; one line honouring it here turns a prompt injection into a read of
 * `http://mcp-argocd.agent-mcps.svc.cluster.local/`. Cheap to check, and the
 * kind of line that looks like a consistency fix to whoever adds it. The
 * adapter has a list of its own (`URL_FETCH_INTERNAL_HOST_SUFFIXES`), and the
 * point of it being a second list is that this file never reads the first —
 * nor any configuration at all: its list is injected by the composition root.
 */
const MODEL_CHOSEN_URL_FETCHER = "src/infrastructure/net/httpResource.ts";

describe("URLs the model chose", () => {
  const file = SOURCE_FILES.find((f) => f.path === MODEL_CHOSEN_URL_FETCHER);

  it("are fetched by exactly one adapter", () => {
    expect(file).toBeDefined();
    const importers = SOURCE_FILES.filter(
      (f) =>
        f.path !== MODEL_CHOSEN_URL_FETCHER &&
        parseImports(f.text).some(
          (i) => resolveSpec(i.spec, f.path) === "@/application/llm/urlContent" && !i.typeOnly,
        ),
    ).map((f) => f.path);
    // Only the builtin's builder reaches the use case; nothing else fetches.
    expect(importers).toEqual(["src/application/execution/urlTool.ts"]);
  });

  it("never consult the MCP internal-host exemption", () => {
    const text = file?.text ?? "";
    const imports = parseImports(text);
    const names = imports.flatMap((i) => i.names);
    expect(names).not.toContain("skipsUrlGuard");
    expect(imports.map((i) => resolveSpec(i.spec, MODEL_CHOSEN_URL_FETCHER))).not.toContain(
      "@/lib/config",
    );
    expect(stripComments(text)).not.toMatch(
      /skipsUrlGuard|mcpInternalHostSuffixes|MCP_INTERNAL_HOST_SUFFIXES|loopback|process\.env/,
    );
  });

  it("carry no credential of this deployment's", () => {
    // Not the tenant header, not an OAuth token, not a bot token. A redirect
    // cannot forward what was never attached.
    const text = stripComments(file?.text ?? "");
    expect(text).not.toMatch(/TENANT_ID_HEADER|Authorization|Bearer|botToken/);
  });
});

describe("run artifacts", () => {
  it("are captured only where this list says", () => {
    const importers = SOURCE_FILES.filter((file) =>
      parseImports(file.text).some(
        (i) =>
          resolveSpec(i.spec, file.path) === "@/application/artifact/runArtifacts" && !i.typeOnly,
      ),
    ).map((file) => file.path);
    expect(importers.sort()).toEqual([...ARTIFACT_CAPTURE_SITES].sort());
  });

  it("are captured by every function that opens a run bracket", () => {
    // `await openRun(` rather than the bare name, so the module that *declares*
    // it is not asked to also use what it builds.
    const openers = SOURCE_FILES.filter(
      (file) => file.path.startsWith("src/") && /await openRun\(/.test(stripComments(file.text)),
    );
    // Anchors the check: an `openRun` that stopped matching would empty this and
    // read as a clean pass.
    expect(openers.length).toBeGreaterThanOrEqual(2);
    const missing = openers
      .filter((file) => !/bracket\.artifacts|captureRunArtifacts\(/.test(stripComments(file.text)))
      .map((file) => file.path);
    expect(missing).toEqual([]);
  });
});

/**
 * The two output axes travel together.
 *
 * `EngineChunk.file` is its own axis because a DOCX is not a picture — ten
 * consumers know `chunk.image` and would have uploaded one to Slack as one. But
 * being its own axis is exactly how it went missing: the field was added with
 * the chat view in mind and reached nowhere else, so `/predict`, both OpenAI
 * shapes, A2A, Slack and a trigger's history row each read the image beside it
 * and dropped the file on the floor. The document was stored as an artifact and
 * the caller was never told it existed — and because every one of those surfaces
 * *does* answer with images, nothing about them said files were different.
 *
 * So the rule is a pairing rather than a list: a module that reads one output
 * axis reads the other. What it then does with them is its own business —
 * Slack links a file and uploads a picture, A2A addresses one by uri and inlines
 * the other's bytes — and none of those differences is what this catches. What
 * it catches is a seventh surface reading only `chunk.image`, which is the exact
 * shape of every one of the six.
 *
 * The exemptions are the places whose subject really is one axis: the image
 * pipeline itself, and the client-side wire shapes that mirror one field.
 */
const ONE_AXIS_ON_PURPOSE = [
  // The image use case and its channel: an image project's whole output.
  "src/application/image/generateImage.ts",
  // Reads a turn's *attached* images, which have no file counterpart — a
  // document a person attaches becomes text before it reaches a turn.
  "src/application/llm/imageParts.ts",
  // The file module itself: its whole subject is the axis this rule exists to
  // keep from being forgotten, and pairing it with images would mean the owner
  // of one answer also handling the other.
  "src/application/artifact/producedFiles.ts",
];

/**
 * The routes whose answer *is* the engine's chunk.
 *
 * Two of them, and they have to agree: `/agent` and `/predict` with
 * `stream: true` hand the same frames to the same SSE helper. A file frame
 * leaving either one carries the object key and artifact id the run bracket put
 * on it unless something swaps them for an address — which is a leak of this
 * platform's bookkeeping in one direction and, in the other, a frame naming a
 * document the caller has no way to fetch.
 *
 * The chat routes are deliberately absent: they wrap their own envelope and sign
 * a file when the finished turn is read back, a turn later, because a run there
 * outlives the connection that started it and a signature minted mid-run would
 * be spent on a reader who may not be attached.
 */
const RAW_CHUNK_STREAM_ROUTES = [
  "src/app/api/projects/[name]/versions/[version]/agent/route.ts",
  "src/app/api/projects/[name]/versions/[version]/predict/route.ts",
];

describe("what a run produced", () => {
  it("is addressed by every route that answers in raw chunks", () => {
    const addressing = SOURCE_FILES.filter((file) =>
      /withAddressedFiles\(/.test(stripComments(file.text)),
    ).map((file) => file.path);
    // The module that declares it is not asked to also use it.
    expect(addressing.filter((path) => path.startsWith("src/app/")).sort()).toEqual(
      [...RAW_CHUNK_STREAM_ROUTES].sort(),
    );
  });

  it("is read on both axes wherever it is read at all", () => {
    // The receiver is a chunk whatever it was bound to, and a wildcard cannot
    // say that: `.image` is a container image and `.file` is a Teams
    // attachment in seventeen files that have nothing to do with this. So the
    // bindings are named, and a new one is added here on purpose — which is
    // what `restored` cost: `runSubagentWithPii` read `restored.image` and
    // this check, looking only for `chunk.`, never saw that `restored.file`
    // was missing from the gate beside it.
    const reads = (text: string, field: "image" | "file") =>
      new RegExp(String.raw`\b(?:chunk|restored)\.${field}\b`).test(text);
    const oneAxis = SOURCE_FILES.filter((file) => {
      if (!file.path.startsWith("src/") || ONE_AXIS_ON_PURPOSE.includes(file.path)) {
        return false;
      }
      const text = stripComments(file.text);
      return reads(text, "image") !== reads(text, "file");
    }).map((file) => file.path);
    expect(oneAxis).toEqual([]);
  });
});

/**
 * Who folds a run's thinking.
 *
 * `delta.reasoningContent` is the one axis a version can switch off, so unlike
 * the answer beside it a surface cannot tell "this run did not think" from "I
 * am not reading it" — which is how it reached nowhere at all for as long as it
 * did, emitted by the engine and consumed by no one.
 *
 * Four surfaces fold it now, and each pairs the same three decisions: keep only
 * what `isTopLevelChunk` allows (a child's thinking is its own run's), pace the
 * commit (it arrives a token at a time and the string only grows), and carry
 * the token count beside the text (the common OpenAI shape reports a count and
 * streams nothing). `SideResult` had already dropped the third before this list
 * existed. A fifth surface is added here on purpose.
 *
 * The chat's two are one fold each on either side of the wire — what the store
 * shows and what the run persists — and the console's two hold it in component
 * state, which is why they are the pair that needs `textPacer`.
 */
const REASONING_FOLD_SITES = [
  "src/application/chat/run.ts",
  "src/app/chats/_lib/stream.ts",
  "src/app/projects/[name]/_components/RunPanel.tsx",
  "src/app/projects/[name]/compare/page.tsx",
  // Forwards it as the protocol's REASONING_* events rather than folding it,
  // but the same two of the three decisions apply: top level only, and the
  // token count beside it (on RUN_FINISHED's usage).
  "src/application/agui/events.ts",
];

describe("folding a run's reasoning", () => {
  const folds = (text: string) => /reasoningContent/.test(text);

  it("happens only where the list says", () => {
    const found = SOURCE_FILES.filter(
      (file) =>
        file.path.startsWith("src/app/") ||
        file.path.startsWith("src/application/chat/") ||
        file.path.startsWith("src/application/messaging/") ||
        file.path.startsWith("src/application/agui/"),
    )
      .filter((file) => folds(stripComments(file.text)))
      .map((file) => file.path)
      .filter((path) => !REASONING_FOLD_SITES.includes(path));
    // Three name the field without folding a run's thinking: the client's wire
    // shape declares it, the run log substitutes a note for it, and the API
    // reference lists it among the frames `/agent` sends.
    expect(found).toEqual([
      "src/app/chats/_lib/types.ts",
      "src/app/projects/[name]/api-reference/endpoints.ts",
      "src/application/chat/runLog.ts",
    ]);
  });

  it("keeps the top level only, everywhere it is folded", () => {
    const missing = REASONING_FOLD_SITES.filter((path) => {
      const file = SOURCE_FILES.find((candidate) => candidate.path === path);
      return file === undefined || !/isTopLevelChunk/.test(stripComments(file.text));
    });
    expect(missing).toEqual([]);
  });

  it("paces every fold that holds it in component state", () => {
    // Named, not derived from a directory: a fifth console surface anywhere
    // else would otherwise be checked for the author gate and silently exempted
    // from the pacing, which is the per-token re-render this list exists for.
    // `stream.ts` folds into the chat store, which paces its own notifications;
    // `run.ts` renders nothing at all.
    const PACED_BY_SOMETHING_ELSE = [
      "src/application/chat/run.ts",
      "src/app/chats/_lib/stream.ts",
      // A wire translator holds nothing in component state.
      "src/application/agui/events.ts",
    ];
    const unpaced = REASONING_FOLD_SITES.filter(
      (path) => !PACED_BY_SOMETHING_ELSE.includes(path),
    ).filter((path) => {
      const file = SOURCE_FILES.find((candidate) => candidate.path === path);
      return file === undefined || !/createTextPacer/.test(stripComments(file.text));
    });
    expect(unpaced).toEqual([]);
  });
});

/**
 * Who may start an agent run.
 *
 * The same shape as the image list above, for the other half of the facade.
 * `executeAgent` is safe to call directly — it refuses a non-agent project
 * itself, which is the check `/agent` was the one caller to lack — so five
 * surfaces do: the `/agent` route, and the four `runAgent` bindings that let a
 * chat, a Slack thread, a Telegram chat and a Teams conversation inject the
 * facade at their own wiring site.
 *
 * What that costs is that "how a run is entered" has more than one place, while
 * "which project type runs which way" has exactly one (`runStrategyFor`). A
 * policy that belongs at the entry — a per-surface input cap, a rate limit —
 * therefore has five homes and nothing saying where they are. This is that
 * statement, and it is why a sixth is added here on purpose.
 *
 * Keyed on the import rather than on the text: `chat/deps.ts` and `slack/types.ts`
 * both name `executeAgent` in a doc comment describing what their injected
 * `runAgent` is bound to. Those are descriptions of the boundary, not crossings
 * of it, and a list that included them would come to mean "files that mention
 * it".
 *
 * A surface that can render any project type calls `streamProjectRun`; one that
 * answers with a completion calls `executeProject`/`executeProjectStream`. Both
 * reach the agent loop through `runStrategyFor` and neither belongs here.
 */
const AGENT_RUN_ENTRY_POINTS = [
  // Answers with SSE chunks, for a caller driving one version directly.
  "src/app/api/projects/[name]/versions/[version]/agent/route.ts",
  // Binds `ChatDeps.runAgent`; the chat use cases never see the facade.
  "src/app/api/chats/_deps.ts",
  // Binds `SlackEventDeps.runAgent`, the same way.
  "src/app/api/slack/events/_lib/handleEventRequest.ts",
  // Binds `TelegramEventDeps.runAgent`, the same way.
  "src/app/api/telegram/webhook/_lib/handleUpdateRequest.ts",
  // Binds `TeamsEventDeps.runAgent`, the same way.
  "src/app/api/teams/messages/_lib/handleActivityRequest.ts",
];

/**
 * Everywhere a version's tools are resolved, and what each one has to remember.
 *
 * `resolveRunTools` takes its search queries as an *optional* fourth argument,
 * and a caller that omits it gets a run with capability discovery silently
 * switched off — the version's `dynamicCapabilities` still reads as on, the
 * bindings still resolve, and nothing anywhere says the search never happened.
 * That is not a hypothetical: two of these three shipped without it. The
 * subagent path ran every transferred-to child on its bindings alone, and the
 * preview showed a prompt smaller than the run it claims to describe.
 *
 * So the callers are a bounded list, like the agent-run entry points above, and
 * a fourth is added here on purpose — with `discoveryQueries` in hand.
 */
const TOOL_RESOLUTION_SITES = [
  // The top-level agent run; queries come from the newest user turn.
  "src/application/execution/runProject.ts",
  // A transferred-to child; the transfer message is its whole request.
  "src/application/execution/subagentRunner.ts",
  // The Playground preview; the request is optional there, and without one it
  // shows the floor every run starts from.
  "src/application/execution/promptPreview.ts",
];

describe("tool resolution", () => {
  it("happens only where discovery queries are supplied with it", () => {
    const callers = SOURCE_FILES.filter(
      (file) =>
        file.path !== "src/application/execution/bindings.ts" &&
        /\bresolveRunTools\(/.test(file.text),
    ).map((file) => file.path);
    expect(callers.sort()).toEqual([...TOOL_RESOLUTION_SITES].sort());
  });

  it("passes discovery queries at every one of them", () => {
    // Naming the helper is the check: it is the only thing that builds the
    // pair of queries, so a call site that resolves tools without mentioning
    // it is one that resolves them without a search.
    for (const path of TOOL_RESOLUTION_SITES) {
      const file = SOURCE_FILES.find((candidate) => candidate.path === path);
      expect({ path, usesQueries: /\bdiscoveryQueries\(/.test(file?.text ?? "") }).toEqual({
        path,
        usesQueries: true,
      });
    }
  });

  it("passes the run's origin at every site that runs", () => {
    // The fifth argument is optional, and an omitted one reads exactly like a
    // run with no conversation — the MCP header quietly absent, nothing saying
    // so. The preview alone stands for no conversation and is exempt by name.
    for (const path of TOOL_RESOLUTION_SITES) {
      if (path === "src/application/execution/promptPreview.ts") {
        continue;
      }
      const file = SOURCE_FILES.find((candidate) => candidate.path === path);
      const call = /resolveRunTools\(([\s\S]*?)\);/.exec(file?.text ?? "");
      expect({ path, passesOrigin: /\borigin\b/.test(call?.[1] ?? "") }).toEqual({
        path,
        passesOrigin: true,
      });
    }
  });
});

describe("agent runs", () => {
  it("start at the entry points that declare themselves here", () => {
    const callers = SOURCE_FILES.filter((file) =>
      parseImports(file.text).some(
        (i) =>
          resolveSpec(i.spec, file.path) === "@/application/execution/runProject" &&
          !i.typeOnly &&
          bindsName(i, "executeAgent"),
      ),
    ).map((file) => file.path);
    expect(callers.sort()).toEqual([...AGENT_RUN_ENTRY_POINTS].sort());
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

/**
 * Mantine components whose root element is a block-level `<div>`.
 *
 * `<Text>` renders a `<p>`, which accepts phrasing content only: a browser
 * *closes the paragraph* where a `<div>` opens inside it, so the server's HTML
 * and React's tree disagree about the shape of the document and hydration
 * fails. The plugins sync summary put a `<Badge>` inside a `<Text>` and every
 * sync logged "In HTML, <div> cannot be a descendant of <p>".
 *
 * The fix is per-component and cheap — `component="span"` on the inner one, or
 * a `Group` around both — but nothing made the mistake visible before a browser
 * ran the page, which is why it is caught here.
 */
const BLOCK_ROOTED = [
  "Badge", "Group", "Stack", "Divider", "Card", "Paper", "Alert", "SimpleGrid",
  "Progress", "ScrollArea", "ThemeIcon", "Skeleton", "Table", "Center", "Flex",
  "Grid", "GridCol", "Avatar", "Accordion", "Timeline", "Tabs", "Blockquote",
  "List", "Chip", "Pill", "Indicator", "RingProgress", "Spoiler", "Collapse",
];

/**
 * `<X …>` … `</X>` holding one of the above, with no `component=` override on
 * either — the override is how a caller *fixes* this, so a tag carrying one is
 * not a finding. Bounded so the match stays inside one element's own children.
 */
const PHRASING_CONTAINERS = ["Text", "Title"];

function nestingOffenders(text: string): string[] {
  const found: string[] = [];
  for (const outer of PHRASING_CONTAINERS) {
    const re = new RegExp(`<${outer}(?![A-Za-z])([^>]*)>([\\s\\S]{0,600}?)</${outer}>`, "g");
    for (const [, attrs, body] of text.matchAll(re)) {
      if (/component=/.test(attrs ?? "")) {
        continue;
      }
      for (const inner of BLOCK_ROOTED) {
        const innerRe = new RegExp(`<${inner}(?![A-Za-z])([^>]*)>`);
        const hit = innerRe.exec(body ?? "");
        if (hit && !/component=/.test(hit[1] ?? "")) {
          found.push(`<${inner}> inside <${outer}>`);
        }
      }
    }
  }
  return found;
}

describe("react event handling", () => {
  it("never reads currentTarget inside a state updater", () => {
    const offenders = SOURCE_FILES.filter(
      (file) => file.path.endsWith(".tsx") && DEFERRED_EVENT_READ.test(file.text),
    ).map((file) => file.path);
    expect(offenders.sort()).toEqual([]);
  });

  it("never nests a block-rooted component inside Text or Title", () => {
    const offenders: string[] = [];
    for (const file of SOURCE_FILES) {
      if (!file.path.endsWith(".tsx")) {
        continue;
      }
      for (const finding of nestingOffenders(file.text)) {
        offenders.push(`${file.path}: ${finding}`);
      }
    }
    expect(offenders.sort()).toEqual([]);
  });

  it("catches the nesting it is meant to catch", () => {
    expect(nestingOffenders(`<Text fz="xs"><Badge size="xs">created</Badge>a, b</Text>`)).toEqual([
      "<Badge> inside <Text>",
    ]);
    // `component="span"` is the fix, so a tag carrying one is not a finding.
    expect(
      nestingOffenders(`<Text fz="xs"><Badge component="span">created</Badge>a</Text>`),
    ).toEqual([]);
    // `<Text component="div">` is the other fix — the container is no longer a <p>.
    expect(nestingOffenders(`<Text component="div"><Badge>x</Badge></Text>`)).toEqual([]);
    // Phrasing content inside a paragraph is exactly what <p> is for.
    expect(nestingOffenders(`<Text fz="xs"><Code>npm i</Code> then run it</Text>`)).toEqual([]);
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
      { spec: "@/domain/a", typeOnly: false, dynamic: false, names: ["a"] },
      { spec: "@/domain/b", typeOnly: true, dynamic: false, names: ["B"] },
      { spec: "@/domain/cd", typeOnly: false, dynamic: false, names: ["c", "d"] },
      { spec: "@/infrastructure/e", typeOnly: true, dynamic: false, names: ["E"] },
      // An inline `type` among value imports is still a value import, and the
      // name it carries is the binding without its `type` prefix.
      { spec: "@/domain/fg", typeOnly: false, dynamic: false, names: ["F", "g"] },
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
      // No names: the bindings are in the destructuring, not in a clause. See
      // `parseImports` for why they are not guessed at.
      { spec: "@/lib/config", typeOnly: false, dynamic: true, names: [] },
      { spec: "@/infrastructure/db/client", typeOnly: false, dynamic: true, names: [] },
    ]);
  });

  it("does not let a from-less statement swallow the next import", () => {
    const parsed = parseImports(
      [`export type A = () => number;`, `import { b } from "@/domain/b";`].join("\n"),
    );
    // One import, and a value one — not `A`'s `export type` pinned to `b`.
    expect(parsed).toEqual([{ spec: "@/domain/b", typeOnly: false, dynamic: false, names: ["b"] }]);
  });

  it("reads a clause's bindings without its aliases or default", () => {
    // What the by-name entry-point checks rest on. An alias binds a local name
    // the rule never asks about, and a namespace or default import names the
    // module rather than an export — so neither is a named binding.
    const parsed = parseImports(
      [
        `import { executeAgent as run, type Deps } from "@/application/execution/runProject";`,
        `import * as engine from "@/application/llm/engine";`,
        `import React from "react";`,
      ].join("\n"),
    );
    // `* as` binds every export, so it answers yes to every by-name query.
    expect(parsed.map((i) => i.names)).toEqual([["executeAgent", "Deps"], ["*"], []]);
    expect(bindsName(parsed[1]!, "executeAgent")).toBe(true);
    expect(bindsName(parsed[2]!, "executeAgent")).toBe(false);
  });

  it("flags a banned import that is not on the allowlist", () => {
    const rule = RULES.find((r) => r.from === "domain")!;
    expect(rule.banned("@/infrastructure/db/client")).toBe(true);
    expect(rule.banned("@/domain/llm/types")).toBe(false);
  });

  it("lets application reach the domain and the standard library, and nothing else", () => {
    // The rule passes today because `application` imports `node:crypto` and the
    // A2A SDK. Asserted directly so "it passes" cannot come to mean "it stopped
    // matching" — a package name is the thing it has to keep recognising.
    const rule = RULES.find(
      (r) => r.name === "application imports only the domain and the standard library",
    )!;
    expect(rule.banned("@/domain/llm/types")).toBe(false);
    expect(rule.banned("node:crypto")).toBe(false);
    expect(rule.banned("@a2a-js/sdk/server")).toBe(false);
    // The shapes it exists to stop: an SDK, a client, a parser, the framework.
    expect(rule.banned("@aws-sdk/client-dynamodb")).toBe(true);
    expect(rule.banned("openai")).toBe(true);
    expect(rule.banned("undici")).toBe(true);
    expect(rule.banned("unpdf")).toBe(true);
    expect(rule.banned("next/server")).toBe(true);
    expect(rule.banned("zod")).toBe(true);
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
