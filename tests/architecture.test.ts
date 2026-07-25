/**
 * Layer boundary enforcement (M1).
 *
 * The dependency rule `app → application → domain ← infrastructure` lived only
 * in docs/ARCHITECTURE.md, so nothing stopped it from eroding. This test makes
 * it mechanical: no new dependency, just `node:fs` and a regex.
 *
 * Existing violations are FROZEN in per-rule allowlists rather than fixed here.
 * That keeps CI green while M1–M3 remove them one group at a time, and any NEW
 * violation still fails immediately. The allowlists are exact (`toEqual` on a
 * sorted array) on purpose: comparing counts, or matching loosely, would let one
 * violation disappear while another appears and call it unchanged.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
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
 */
const IMPORT_RE = /(?:^|\n)[ \t]*(?:import|export)\b([\s\S]*?)from[ \t]*["']([^"']+)["']/g;

export interface ModuleImport {
  spec: string;
  /** True for `import type …` / `export type …`, whose cost is compile-time only. */
  typeOnly: boolean;
}

export function parseImports(source: string): ModuleImport[] {
  return [...source.matchAll(IMPORT_RE)].map((match) => ({
    spec: match[2]!,
    // `import { type A }` mixes a type in with value imports — not type-only.
    typeOnly: /^type\b/.test((match[1] ?? "").trim()),
  }));
}

/** `src/application/foo/bar.ts` → `application`. */
function layerOf(relPath: string): string | null {
  return /^src\/([^/]+)/.exec(relPath)?.[1] ?? null;
}

/** `@/infrastructure/db/keys` → `infrastructure`; bare packages → null. */
function targetLayer(spec: string): string | null {
  return /^@\/([^/]+)/.exec(spec)?.[1] ?? null;
}

interface Rule {
  name: string;
  /** Which files the rule governs. */
  from: string;
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
 * allowlist entry — folding permanent exceptions into the freeze list would
 * destroy "the list is empty" as a completion signal for M3.
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
    // 28 → 21 → 10 → 0 across M1, M2 and M3.
    //
    // M1 removed 12 (secretEncryption 7, ssrfGuard 4, timingSafe 1) and added 5:
    // each slice `index.ts` now imports the port implementations it injects. That
    // trade is deliberate — a slice index is today's composition site for its
    // singleton, and M2 removes all 11 of these index entries when those
    // singletons move into `lib/container.ts`.
    allow: [
      "src/application/agent/agentUseCases.ts -> @/infrastructure/a2a/client",
      "src/application/agent/agentUseCases.ts -> @/infrastructure/agent/agentClient",
      "src/application/agent/index.ts -> @/infrastructure/agent/agentClient (type)",
      "src/application/agent/index.ts -> @/infrastructure/crypto/secretCipher",
      "src/application/agent/index.ts -> @/infrastructure/db/repositories/externalAgentRepository",
      "src/application/agent/index.ts -> @/infrastructure/net/urlPolicy",
      "src/application/execution/runProject.ts -> @/infrastructure/a2a/client",
      "src/application/execution/runProject.ts -> @/infrastructure/mcp/toolManager",
      "src/application/execution/runProject.ts -> @/infrastructure/net/publicFetch",
      "src/application/mcp/index.ts -> @/infrastructure/crypto/secretCipher",
      "src/application/mcp/index.ts -> @/infrastructure/db/repositories/mcpRepository",
      "src/application/mcp/index.ts -> @/infrastructure/mcp/mcpClient (type)",
      "src/application/mcp/index.ts -> @/infrastructure/net/urlPolicy",
      "src/application/mcp/mcpUseCases.ts -> @/infrastructure/mcp/discoveryCache",
      "src/application/mcp/mcpUseCases.ts -> @/infrastructure/mcp/mcpClient",
      "src/application/settings/index.ts -> @/infrastructure/crypto/secretCipher",
      "src/application/settings/index.ts -> @/infrastructure/db/repositories/settingsRepository",
      "src/application/settings/settingsUseCases.ts -> @/infrastructure/llm/providers",
      "src/application/skill/index.ts -> @/infrastructure/db/repositories/skillRepository",
      "src/application/skill/syncSkills.ts -> @/infrastructure/github/skillsRepoClient (type)",
      "src/application/slack/handleSlackEvent.ts -> @/infrastructure/slack/client (type)",
    ],
  },
  {
    name: "infrastructure imports no application or app",
    from: "infrastructure",
    banned: (spec) => ["application", "app"].includes(targetLayer(spec) ?? ""),
    allow: [],
  },
  {
    name: "app imports no infrastructure outside its wiring sites",
    from: "app",
    banned: (spec) => targetLayer(spec) === "infrastructure",
    exempt: (relPath) => APP_WIRING_SITES.some((site) => relPath.startsWith(site)),
    // Emptied by M3 (A2A exposure use case, slack test route).
    allow: [
      "src/app/api/a2a/[name]/.well-known/agent-card.json/route.ts -> @/infrastructure/a2a/cards",
      "src/app/api/a2a/[name]/route.ts -> @/infrastructure/a2a/cards",
      "src/app/api/a2a/[name]/route.ts -> @/infrastructure/crypto/timingSafe",
      "src/app/api/a2a/route.ts -> @/infrastructure/a2a/cards",
      "src/app/api/projects/[name]/a2a/route.ts -> @/infrastructure/a2a/cards",
      "src/app/api/projects/[name]/slack/test/route.ts -> @/infrastructure/slack/client",
      "src/app/api/skills/sync/route.ts -> @/infrastructure/github/skillsRepoClient",
    ],
  },
];

/** `relative()` yields OS separators; the allowlists are written with `/`. */
const SOURCE_FILES = walk(SRC).map((absolute) => ({
  path: relative(ROOT, absolute).split("\\").join("/"),
  text: readFileSync(absolute, "utf8"),
}));

function violationsOf(rule: Rule): string[] {
  const found: string[] = [];
  for (const file of SOURCE_FILES) {
    if (layerOf(file.path) !== rule.from) continue;
    if (rule.exempt?.(file.path)) continue;
    for (const { spec, typeOnly } of parseImports(file.text)) {
      if (rule.banned(spec)) {
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

  it("flags a banned import that is not on the allowlist", () => {
    const rule = RULES.find((r) => r.from === "domain")!;
    expect(rule.banned("@/infrastructure/db/client")).toBe(true);
    expect(rule.banned("@/domain/llm/types")).toBe(false);
  });
});
