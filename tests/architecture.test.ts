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
}

export function parseImports(source: string): ModuleImport[] {
  return [
    ...[...source.matchAll(STATIC_IMPORT_RE)].map((match) => ({
      spec: match[2]!,
      // `import { type A }` mixes a type in with value imports — not type-only.
      typeOnly: /^type\b/.test((match[1] ?? "").trim()),
    })),
    ...[...source.matchAll(INLINE_IMPORT_RE)].map((match) => ({
      spec: match[1]!,
      // Separating a runtime `await import()` from a type-position one needs a
      // parser. The stricter reading wins: a banned target is reported either way.
      typeOnly: false,
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
    name: "app imports no infrastructure outside its wiring sites",
    from: "app",
    banned: (spec) => targetLayer(spec) === "infrastructure",
    exempt: (relPath) => APP_WIRING_SITES.some((site) => relPath.startsWith(site)),
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
    what: "the 401 response body",
    pattern: /error: "Unauthorized"/,
    owner: "src/shared/unauthorized.ts",
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
      { spec: "@/domain/a", typeOnly: false },
      { spec: "@/domain/b", typeOnly: true },
      { spec: "@/domain/cd", typeOnly: false },
      { spec: "@/infrastructure/e", typeOnly: true },
      // An inline `type` among value imports is still a value import.
      { spec: "@/domain/fg", typeOnly: false },
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
      { spec: "@/lib/config", typeOnly: false },
      { spec: "@/infrastructure/db/client", typeOnly: false },
    ]);
  });

  it("does not let a from-less statement swallow the next import", () => {
    const parsed = parseImports(
      [`export type A = () => number;`, `import { b } from "@/domain/b";`].join("\n"),
    );
    // One import, and a value one — not `A`'s `export type` pinned to `b`.
    expect(parsed).toEqual([{ spec: "@/domain/b", typeOnly: false }]);
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
