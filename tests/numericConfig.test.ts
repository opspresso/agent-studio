/**
 * The two numeric env parsers, and the settings that go through them.
 *
 * Three modules used to parse their own: the MCP discovery TTLs froze theirs at
 * import, the retention windows fell back in silence, and the trace rate had a
 * second clamp in the composition root. What a wrong value does is now one
 * answer per shape — fall back for a limit, clamp for a rate — and it is said
 * out loud either way.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config, fractionEnv, positiveIntEnv, resetConfigWarnings } from "@/lib/config";
import { RETENTION } from "@/infrastructure/db/ttl";
import { getCachedTools, setCachedTools } from "@/infrastructure/mcp/discoveryCache";

const TOUCHED = [
  "PROBE_NUMBER",
  "TRACE_SAMPLE_RATE",
  "USAGE_RETENTION_DAYS",
  "MCP_DISCOVERY_CACHE_TTL_MS",
  "MCP_MAX_SERVER_TTL_MS",
  "MAX_CONCURRENT_RUNS_PER_ACTOR",
  "MAX_CONCURRENT_RUNS_A2A",
  "EMBEDDING_DIM",
  "RERANKER_MIN_SCORE",
] as const;
const ORIGINAL = Object.fromEntries(TOUCHED.map((key) => [key, process.env[key]]));

function set(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

beforeEach(() => {
  // The warning is deduped per setting+value, so a test asserting on it has to
  // start from a process that has not already said this one.
  resetConfigWarnings();
});

afterEach(() => {
  for (const key of TOUCHED) {
    set(key, ORIGINAL[key]);
  }
  vi.restoreAllMocks();
});

describe("positiveIntEnv", () => {
  it("takes a whole number at or above the floor", () => {
    set("PROBE_NUMBER", "42");
    expect(positiveIntEnv("PROBE_NUMBER", 7)).toBe(42);
  });

  it.each(["abc", "-1", "1.5", ""])("falls back on %o rather than reading it as zero", (raw) => {
    // `Number("abc") || 0` would read as "limit off", which is the opposite of
    // what a typo should mean.
    set("PROBE_NUMBER", raw);
    expect(positiveIntEnv("PROBE_NUMBER", 7)).toBe(7);
  });

  it("honours a floor above zero", () => {
    set("PROBE_NUMBER", "0");
    expect(positiveIntEnv("PROBE_NUMBER", 7)).toBe(0);
    expect(positiveIntEnv("PROBE_NUMBER", 7, 1)).toBe(7);
  });

  it("honours a storage ceiling", () => {
    set("PROBE_NUMBER", "1000");
    expect(positiveIntEnv("PROBE_NUMBER", 7, 0, 1000)).toBe(1000);
    set("PROBE_NUMBER", "1001");
    expect(positiveIntEnv("PROBE_NUMBER", 7, 0, 1000)).toBe(7);
  });
});

describe("fractionEnv", () => {
  it("takes a rate inside the range", () => {
    set("PROBE_NUMBER", "0.25");
    expect(fractionEnv("PROBE_NUMBER", 0.1)).toBe(0.25);
  });

  it("clamps out of range instead of falling back", () => {
    // A rate of `2` means "as much as possible"; refusing it would be pedantry.
    set("PROBE_NUMBER", "2");
    expect(fractionEnv("PROBE_NUMBER", 0.1)).toBe(1);
    set("PROBE_NUMBER", "-3");
    expect(fractionEnv("PROBE_NUMBER", 0.1)).toBe(0);
  });

  it("falls back on a value that is not a number at all", () => {
    set("PROBE_NUMBER", "often");
    expect(fractionEnv("PROBE_NUMBER", 0.1)).toBe(0.1);
  });

  it("says so both times", () => {
    // A sampling rate that quietly became something else is how a deployment
    // ends up reasoning from traces it never recorded.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    set("PROBE_NUMBER", "2");
    fractionEnv("PROBE_NUMBER", 0.1);
    set("PROBE_NUMBER", "often");
    fractionEnv("PROBE_NUMBER", 0.1);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("the settings that used to parse their own", () => {
  it("allows an embedding model to choose its native dimension", () => {
    set("EMBEDDING_DIM", "native");
    expect(config.embeddingDimensions).toBeUndefined();
    set("EMBEDDING_DIM", "2560");
    expect(config.embeddingDimensions).toBe(2560);
  });

  it("clamps the reranker relevance floor", () => {
    set("RERANKER_MIN_SCORE", "2");
    expect(config.rerankerMinScore).toBe(1);
  });

  it("uses the measured capability reranker noise floor by default", () => {
    set("RERANKER_MIN_SCORE", undefined);
    expect(config.rerankerMinScore).toBe(0.01);
  });

  it("keeps concurrency settings inside the stored slot-key range", () => {
    set("MAX_CONCURRENT_RUNS_PER_ACTOR", "1000");
    set("MAX_CONCURRENT_RUNS_A2A", "1000");
    expect(config.maxConcurrentRunsPerActor).toBe(1000);
    expect(config.maxConcurrentRunsA2a).toBe(1000);

    set("MAX_CONCURRENT_RUNS_PER_ACTOR", "1001");
    set("MAX_CONCURRENT_RUNS_A2A", "1001");
    expect(config.maxConcurrentRunsPerActor).toBe(10);
    expect(config.maxConcurrentRunsA2a).toBe(50);
  });

  it("reads the trace sample rate through config, clamped", () => {
    set("TRACE_SAMPLE_RATE", "5");
    expect(config.traceSampleRate).toBe(1);
    set("TRACE_SAMPLE_RATE", undefined);
    expect(config.traceSampleRate).toBe(0.1);
  });

  it("warns once on a retention window it had to ignore, not once per row", () => {
    // Two things at once. It used to fall back in silence, so a typo deleted
    // rows a year early with nothing in the log to say the configured value had
    // not been used. And this is a getter read on *every* row write — once per
    // model call for usage — so warning from inside it without a memo turns one
    // bad variable into a line per write, burying the message in the
    // deployments that most need to read it.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    set("USAGE_RETENTION_DAYS", "not-a-number");
    expect(RETENTION.usageDays).toBe(400);
    expect(RETENTION.usageDays).toBe(400);
    expect(RETENTION.usageDays).toBe(400);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("re-reports a setting whose value changed", () => {
    // Keyed by value, not just name: a variable corrected — or broken a second
    // way — at runtime still says what it did the next time.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    set("USAGE_RETENTION_DAYS", "400d");
    expect(RETENTION.usageDays).toBe(400);
    set("USAGE_RETENTION_DAYS", "400 days");
    expect(RETENTION.usageDays).toBe(400);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("lets the discovery cache see a TTL that changed after it was imported", () => {
    // Asserted through the consumer, not the getter. `config.mcp*` is a getter
    // by construction, so reading it proves nothing — the property under test is
    // that `discoveryCache` calls it per use rather than hoisting it to module
    // scope, which is the shape this replaced and which the `configuration
    // reads` rule cannot see (it matches `process.env`, not a frozen `config.x`).
    const headers = {};
    const tool = [{ name: "query" }];

    set("MCP_DISCOVERY_CACHE_TTL_MS", "0");
    setCachedTools("https://ttl.test/a", headers, tool);
    expect(getCachedTools("https://ttl.test/a", headers)).toBeUndefined();

    set("MCP_DISCOVERY_CACHE_TTL_MS", "60000");
    setCachedTools("https://ttl.test/b", headers, tool);
    expect(getCachedTools("https://ttl.test/b", headers)).toEqual(tool);
  });

  it("treats 0 as a setting on both MCP knobs, not a typo", () => {
    // "do not cache", and "ignore what servers ask for".
    set("MCP_DISCOVERY_CACHE_TTL_MS", "0");
    expect(config.mcpDiscoveryCacheTtlMs).toBe(0);
    set("MCP_MAX_SERVER_TTL_MS", "0");
    expect(config.mcpMaxServerTtlMs).toBe(0);
  });
});
