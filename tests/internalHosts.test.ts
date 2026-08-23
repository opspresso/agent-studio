import { afterEach, describe, expect, it } from "vitest";
import { isDeclaredInternalHost } from "@/domain/security/internalHosts";
import { skipsUrlGuard, type McpServer } from "@/domain/mcp/types";
import { createMcpUseCases } from "@/application/mcp/mcpUseCases";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { BlockedUrlError, type UrlPolicy } from "@/domain/security/urlPolicy";
import type { McpRepository } from "@/domain/mcp/repository";
import { config } from "@/lib/config";

/**
 * The second way past the SSRF guard.
 *
 * `isManagedLoopback` is pinned in managedMcp.test.ts; this pins the other
 * answer — a host whose suffix the deployment declared internal. It is the only
 * path by which an address someone *typed* (or, for the `FetchUrl` list, a
 * model chose) can reach a private network, so the boundary is tested from both
 * sides: what it must admit, and everything adjacent that it must not.
 */
const CLUSTER = ["agent-mcps.svc.cluster.local"];

describe("isDeclaredInternalHost", () => {
  it("admits a host under a declared suffix", () => {
    expect(
      isDeclaredInternalHost("http://mcp-url-fetch.agent-mcps.svc.cluster.local/mcp", CLUSTER),
    ).toBe(true);
    expect(isDeclaredInternalHost("http://a.b.agent-mcps.svc.cluster.local/mcp", CLUSTER)).toBe(
      true,
    );
  });

  it("admits the suffix itself as an exact host", () => {
    expect(isDeclaredInternalHost("http://agent-mcps.svc.cluster.local/mcp", CLUSTER)).toBe(true);
  });

  it("accepts a leading dot on the suffix as the same thing", () => {
    const url = "http://mcp-url-fetch.agent-mcps.svc.cluster.local/mcp";
    expect(isDeclaredInternalHost(url, [".agent-mcps.svc.cluster.local"])).toBe(true);
  });

  it("matches on a label boundary, never a substring", () => {
    // The attack this exists to refuse: a public name ending in the suffix's
    // characters without ending in its labels.
    expect(isDeclaredInternalHost("http://evil-agent-mcps.svc.cluster.local/mcp", CLUSTER)).toBe(
      false,
    );
    expect(
      isDeclaredInternalHost("http://agent-mcps.svc.cluster.local.evil.test/mcp", CLUSTER),
    ).toBe(false);
  });

  it("treats a trailing dot as the same name", () => {
    expect(
      isDeclaredInternalHost("http://mcp-url-fetch.agent-mcps.svc.cluster.local./mcp", CLUSTER),
    ).toBe(true);
  });

  it("is case-insensitive, as host names are", () => {
    expect(
      isDeclaredInternalHost("http://MCP-URL-Fetch.Agent-MCPS.SVC.Cluster.Local/mcp", CLUSTER),
    ).toBe(true);
  });

  it("refuses a single-label suffix", () => {
    // `local` or `internal` would admit a whole namespace of names; far more
    // likely a mistake than an intent, so it is not honoured at all.
    expect(isDeclaredInternalHost("http://anything.local/mcp", ["local"])).toBe(false);
    expect(isDeclaredInternalHost("http://svc.internal/mcp", ["internal"])).toBe(false);
  });

  it("never matches an IP literal", () => {
    // A declared suffix is a name someone published. An address has no name to
    // match, and a private one still has to earn its way through provenance.
    expect(isDeclaredInternalHost("http://172.20.255.103/mcp", ["20.255.103"])).toBe(false);
    expect(isDeclaredInternalHost("http://10.0.0.1/mcp", CLUSTER)).toBe(false);
    expect(isDeclaredInternalHost("http://[fd00::1]/mcp", CLUSTER)).toBe(false);
  });

  it("changes nothing when no suffix is configured", () => {
    const url = "http://mcp-url-fetch.agent-mcps.svc.cluster.local/mcp";
    expect(isDeclaredInternalHost(url, [])).toBe(false);
    expect(isDeclaredInternalHost(url, ["  "])).toBe(false);
  });

  it("only applies to http(s)", () => {
    expect(
      isDeclaredInternalHost("file://mcp-url-fetch.agent-mcps.svc.cluster.local/mcp", CLUSTER),
    ).toBe(false);
    expect(
      isDeclaredInternalHost("https://mcp-url-fetch.agent-mcps.svc.cluster.local/mcp", CLUSTER),
    ).toBe(true);
  });

  it("refuses an unparseable url", () => {
    expect(isDeclaredInternalHost("not a url", CLUSTER)).toBe(false);
    expect(isDeclaredInternalHost("", CLUSTER)).toBe(false);
  });

  it("is not fooled by userinfo naming the suffix", () => {
    // The host here is evil.test; the suffix appears only in the credentials.
    expect(
      isDeclaredInternalHost("http://agent-mcps.svc.cluster.local@evil.test/mcp", CLUSTER),
    ).toBe(false);
  });
});

describe("skipsUrlGuard — declared internal hosts", () => {
  // The predicate is pinned above; what is pinned here is that the MCP
  // exemption asks it about the entry's url, with the list it was given.
  it("admits a host under a declared suffix, and only under it", () => {
    expect(
      skipsUrlGuard({ url: "http://mcp-url-fetch.agent-mcps.svc.cluster.local/mcp" }, CLUSTER),
    ).toBe(true);
    expect(
      skipsUrlGuard({ url: "http://evil-agent-mcps.svc.cluster.local/mcp" }, CLUSTER),
    ).toBe(false);
    expect(skipsUrlGuard({ url: "http://10.0.0.1/mcp" }, CLUSTER)).toBe(false);
  });

  it("changes nothing when no suffix is configured", () => {
    const url = "http://mcp-url-fetch.agent-mcps.svc.cluster.local/mcp";
    expect(skipsUrlGuard({ url })).toBe(false);
    expect(skipsUrlGuard({ url }, [])).toBe(false);
  });

  it("still admits a managed loopback entry, with or without suffixes", () => {
    const managed = { runtime: "managed" as const, url: "http://127.0.0.1:3001/mcp" };
    expect(skipsUrlGuard(managed)).toBe(true);
    expect(skipsUrlGuard(managed, CLUSTER)).toBe(true);
  });
});

/**
 * Two lists, two env vars. The MCP one names services this app calls; the
 * FetchUrl one names pages a model may read. Reading either from the other's
 * variable is the bug this pins against — a cluster MCP service must not become
 * readable by a prompt injection because it was declared for a different reason.
 */
describe("the two internal-host lists", () => {
  const KEYS = ["MCP_INTERNAL_HOST_SUFFIXES", "URL_FETCH_INTERNAL_HOST_SUFFIXES"] as const;
  const ORIGINAL = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

  function set(name: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  afterEach(() => {
    for (const key of KEYS) {
      set(key, ORIGINAL[key]);
    }
  });

  it("are read from their own variables, and neither from the other's", () => {
    set("MCP_INTERNAL_HOST_SUFFIXES", "agent-mcps.svc.cluster.local");
    set("URL_FETCH_INTERNAL_HOST_SUFFIXES", undefined);
    expect(config.mcpInternalHostSuffixes).toEqual(["agent-mcps.svc.cluster.local"]);
    expect(config.urlFetchInternalHostSuffixes).toEqual([]);

    set("MCP_INTERNAL_HOST_SUFFIXES", undefined);
    set("URL_FETCH_INTERNAL_HOST_SUFFIXES", "wiki.corp.internal");
    expect(config.mcpInternalHostSuffixes).toEqual([]);
    expect(config.urlFetchInternalHostSuffixes).toEqual(["wiki.corp.internal"]);
  });

  it("parse a comma-separated list, trimmed and lowercased, dropping empties", () => {
    set("URL_FETCH_INTERNAL_HOST_SUFFIXES", " Wiki.Corp.Internal, .docs.corp.internal,, ");
    expect(config.urlFetchInternalHostSuffixes).toEqual([
      "wiki.corp.internal",
      ".docs.corp.internal",
    ]);
    // What the parser hands over is what the predicate matches on.
    expect(
      isDeclaredInternalHost("http://page.docs.corp.internal/", config.urlFetchInternalHostSuffixes),
    ).toBe(true);
  });
});

/**
 * The predicate above is only useful if the list actually reaches it. Registering
 * is where that failed in practice — the run path would have called the address
 * happily, but the entry could not be saved — so the wiring is pinned here
 * rather than left to the composition root being read correctly.
 */
describe("registering an entry on a declared internal host", () => {
  /** Stands in for the real guard: refuses anything under the cluster domain. */
  const policy: UrlPolicy = {
    async assertAllowed(url) {
      if (new URL(url).hostname.endsWith(".cluster.local")) {
        throw new BlockedUrlError(`URL host resolves to a private or reserved address`);
      }
    },
  };

  function repoWith(initial: McpServer[] = []): McpRepository {
    const store = new Map(initial.map((s) => [s.name, s]));
    return {
      async list() {
        return [...store.values()];
      },
      async get(name: string) {
        return store.get(name) ?? null;
      },
      async create(server: McpServer) {
        store.set(server.name, server);
      },
      async update(server: McpServer) {
        store.set(server.name, server);
      },
      async put(server: McpServer) {
        store.set(server.name, server);
      },
      async delete(name: string) {
        store.delete(name);
      },
    };
  }

  const probe = { listTools: async () => ({ ok: true as const, tools: [] }), invalidateDiscovery() {} };
  const CLUSTER_URL = "http://mcp-url-fetch.agent-mcps.svc.cluster.local/mcp";
  const make = (suffixes: readonly string[]) =>
    createMcpUseCases(repoWith(), secretCipher, policy, probe, suffixes);

  it("is refused when no suffix is declared", async () => {
    await expect(
      make([]).create({ name: "url-fetch", url: CLUSTER_URL, headers: {} }),
    ).rejects.toThrow(/private or reserved/);
  });

  it("is accepted once the suffix is declared", async () => {
    const created = await make(CLUSTER).create({ name: "url-fetch", url: CLUSTER_URL, headers: {} });
    expect(created.url).toBe(CLUSTER_URL);
  });

  it("does not admit a different private host under the same configuration", async () => {
    await expect(
      make(CLUSTER).create({
        name: "elsewhere",
        url: "http://other-ns.svc.cluster.local/mcp",
        headers: {},
      }),
    ).rejects.toThrow(/private or reserved/);
  });
});
