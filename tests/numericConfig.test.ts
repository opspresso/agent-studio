/**
 * The two numeric env parsers, and the settings that go through them.
 *
 * Three modules used to parse their own: the MCP discovery TTLs froze theirs at
 * import, the retention windows fell back in silence, and the trace rate had a
 * second clamp in the composition root. What a wrong value does is now one
 * answer per shape — fall back for a limit, clamp for a rate — and it is said
 * out loud either way.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { config, fractionEnv, positiveIntEnv } from "@/lib/config";
import { RETENTION } from "@/infrastructure/db/ttl";

const TOUCHED = [
  "PROBE_NUMBER",
  "TRACE_SAMPLE_RATE",
  "USAGE_RETENTION_DAYS",
  "MCP_DISCOVERY_CACHE_TTL_MS",
  "MCP_MAX_SERVER_TTL_MS",
] as const;
const ORIGINAL = Object.fromEntries(TOUCHED.map((key) => [key, process.env[key]]));

function set(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

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
  it("reads the trace sample rate through config, clamped", () => {
    set("TRACE_SAMPLE_RATE", "5");
    expect(config.traceSampleRate).toBe(1);
    set("TRACE_SAMPLE_RATE", undefined);
    expect(config.traceSampleRate).toBe(0.1);
  });

  it("warns on a retention window it had to ignore", () => {
    // It used to fall back in silence, so a typo deleted rows a year early with
    // nothing in the log to say the configured value had not been used.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    set("USAGE_RETENTION_DAYS", "not-a-number");
    expect(RETENTION.usageDays).toBe(400);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("reads the MCP TTLs per call, not once at import", () => {
    // Frozen at module scope they were a process-wide constant nothing declared
    // — and one no test could change after the first import of that module.
    set("MCP_DISCOVERY_CACHE_TTL_MS", "1000");
    expect(config.mcpDiscoveryCacheTtlMs).toBe(1000);
    set("MCP_DISCOVERY_CACHE_TTL_MS", "0");
    expect(config.mcpDiscoveryCacheTtlMs).toBe(0);
    // `0` is a setting here, not a typo: "do not cache", and "ignore what
    // servers ask for".
    set("MCP_MAX_SERVER_TTL_MS", "0");
    expect(config.mcpMaxServerTtlMs).toBe(0);
  });
});
