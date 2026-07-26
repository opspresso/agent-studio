import { describe, expect, it } from "vitest";
import { isManagedLoopback } from "@/domain/mcp/types";

/**
 * The guard-bypass predicate. Everything else about managed servers can be
 * rebuilt; this is the one decision that, if it is wrong, hands the SSRF
 * boundary away — so it is pinned from both sides.
 */
describe("isManagedLoopback", () => {
  it("accepts a loopback address on a managed entry", () => {
    expect(isManagedLoopback({ runtime: "managed", url: "http://127.0.0.1:3001/mcp" })).toBe(true);
    expect(isManagedLoopback({ runtime: "managed", url: "http://[::1]:3001/mcp" })).toBe(true);
  });

  it("refuses a remote entry however local its address looks", () => {
    // The bypass is not a property of the address. A remote entry reached the
    // table by an operator typing it, and must keep facing the guard.
    expect(isManagedLoopback({ runtime: "remote", url: "http://127.0.0.1:3001/mcp" })).toBe(false);
    expect(isManagedLoopback({ url: "http://127.0.0.1:3001/mcp" })).toBe(false);
  });

  it("refuses any address that is not literally loopback", () => {
    for (const url of [
      "http://10.0.0.5:3001/mcp",
      "http://192.168.1.10:3001/mcp",
      "http://169.254.169.254/latest/meta-data/",
      "http://172.31.41.49:3001/mcp",
      "https://example.com/mcp",
    ]) {
      expect(isManagedLoopback({ runtime: "managed", url })).toBe(false);
    }
  });

  it("refuses a hostname that merely resolves to loopback", () => {
    // localhost, and anything else needing resolution, can point somewhere else
    // between this check and the request that follows it.
    expect(isManagedLoopback({ runtime: "managed", url: "http://localhost:3001/mcp" })).toBe(false);
    expect(isManagedLoopback({ runtime: "managed", url: "http://127.0.0.1.nip.io/mcp" })).toBe(false);
  });

  it("refuses a non-http scheme and an unparseable address", () => {
    expect(isManagedLoopback({ runtime: "managed", url: "file:///etc/passwd" })).toBe(false);
    expect(isManagedLoopback({ runtime: "managed", url: "https://127.0.0.1/mcp" })).toBe(false);
    expect(isManagedLoopback({ runtime: "managed", url: "not a url" })).toBe(false);
  });

  it("is not fooled by an address embedded in credentials or a path", () => {
    // `new URL` puts these in username/pathname, not hostname; the check reads
    // hostname, so they stay refused.
    expect(isManagedLoopback({ runtime: "managed", url: "http://127.0.0.1@evil.test/mcp" })).toBe(false);
    expect(isManagedLoopback({ runtime: "managed", url: "http://evil.test/127.0.0.1" })).toBe(false);
  });
});
