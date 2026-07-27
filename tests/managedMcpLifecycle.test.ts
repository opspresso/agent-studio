import { describe, expect, it } from "vitest";
import { createManagedMcpUseCases } from "@/application/mcp/managedMcpUseCases";
import type { McpServer } from "@/domain/mcp/types";
import type { ListToolsResult } from "@/domain/mcp/toolProbe";
import type { ManagedWorkload, ManagedWorkloadSpec, McpProvisioner } from "@/domain/mcp/provisioner";

const REACHABLE: ListToolsResult = { ok: true, tools: [] };
const REFUSED: ListToolsResult = { ok: false, error: "fetch failed" };

interface ProbeCall {
  url: string;
  headers: Record<string, string>;
  loopback?: boolean;
}

function fixture(
  opts: {
    address?: string;
    existing?: McpServer;
    /** What the provisioner reports for `inspect`. */
    running?: boolean;
  } = {},
) {
  const rows = new Map<string, McpServer>();
  if (opts.existing) {
    rows.set(opts.existing.name, opts.existing);
  }
  const stopped: string[] = [];
  const started: string[] = [];
  const startedSpecs: ManagedWorkloadSpec[] = [];
  const provisioner: McpProvisioner = {
    async start(spec) {
      started.push(spec.name);
      startedSpecs.push(spec);
      return {
        name: spec.name,
        address: opts.address ?? "http://127.0.0.1:3001",
        identity: "container-1",
        running: true,
      } satisfies ManagedWorkload;
    },
    async stop(name) {
      stopped.push(name);
    },
    async inspect(name) {
      return rows.has(name)
        ? {
            name,
            address: "http://127.0.0.1:3001",
            identity: "container-1",
            running: opts.running ?? true,
          }
        : null;
    },
  };
  const repo = {
    get: async (name: string) => rows.get(name) ?? null,
    list: async () => [...rows.values()],
    create: async (server: McpServer) => {
      rows.set(server.name, server);
    },
    // Conditional on the row existing, like the real one — the restart path
    // depends on that condition to refuse resurrecting a deleted entry.
    update: async (server: McpServer) => {
      if (!rows.has(server.name)) {
        throw Object.assign(new Error("The conditional request failed"), {
          name: "ConditionalCheckFailedException",
        });
      }
      rows.set(server.name, server);
    },
    put: async (server: McpServer) => {
      rows.set(server.name, server);
    },
    delete: async (name: string) => {
      rows.delete(name);
    },
  };
  const invalidated: string[] = [];
  const probeCalls: ProbeCall[] = [];
  const sleeps: number[] = [];
  // Reachable unless a test says otherwise. `call` is 1-based, so a test can
  // answer "unreachable, then reachable after the restart".
  let answer: (url: string, call: number) => ListToolsResult = () => REACHABLE;
  const probe = {
    listTools: async (url: string, headers: Record<string, string>, loopback?: boolean) => {
      probeCalls.push({ url, headers, ...(loopback === undefined ? {} : { loopback }) });
      return answer(url, probeCalls.length);
    },
    invalidateDiscovery: (url: string) => invalidated.push(url),
  };
  const useCases = createManagedMcpUseCases({
    repo: repo as never,
    provisioner,
    probe: probe as never,
    // Enough of the port to prove the probe is handed decrypted values.
    cipher: { decryptHeadersForOutbound: (h: Record<string, string>) =>
      Object.fromEntries(Object.entries(h).map(([k, v]) => [k, v.replace(/^enc:v1:/, "")])),
    } as never,
    now: () => "2026-01-01T00:00:00.000Z",
    // Recorded, never waited on: a test that sleeps for real is a test nobody
    // runs.
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  });
  return {
    useCases,
    rows,
    stopped,
    started,
    startedSpecs,
    invalidated,
    probeCalls,
    sleeps,
    answerWith: (fn: (url: string, call: number) => ListToolsResult) => {
      answer = fn;
    },
  };
}

const input = { name: "image-fetch", image: "ecr/img:v1", containerPort: 3001 };

function managedRow(patch: Partial<McpServer> = {}): McpServer {
  return {
    name: "image-fetch",
    runtime: "managed",
    url: "http://127.0.0.1:3001/mcp",
    image: "ecr/img:v1",
    containerPort: 3001,
    headers: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

describe("managed MCP lifecycle", () => {
  it("stores the address the provisioner reported", async () => {
    const { useCases, rows } = fixture();
    const server = await useCases.create(input);

    expect(server.runtime).toBe("managed");
    expect(server.url).toBe("http://127.0.0.1:3001/mcp");
    expect(rows.get("image-fetch")?.image).toBe("ecr/img:v1");
  });

  it("refuses to register an address that is not loopback, and stops what it started", async () => {
    // The provisioner is the only source of this value, but not the only thing
    // that has to agree it is safe: a stored entry carries a guard bypass.
    const { useCases, rows, stopped } = fixture({ address: "http://10.0.0.7:3001" });

    await expect(useCases.create(input)).rejects.toThrow(/loopback/);
    expect(rows.has("image-fetch")).toBe(false);
    // and nothing is left running behind a row that was never written
    expect(stopped).toEqual(["image-fetch"]);
  });

  it("removes the container before the entry that points at it", async () => {
    const { useCases, rows, stopped, invalidated } = fixture();
    await useCases.create(input);
    await useCases.remove("image-fetch");

    expect(stopped).toEqual(["image-fetch"]);
    expect(rows.has("image-fetch")).toBe(false);
    expect(invalidated).toEqual(["http://127.0.0.1:3001/mcp"]);
  });

  it("will not touch a remote server through the managed path", async () => {
    const remote: McpServer = {
      name: "github",
      url: "https://api.githubcopilot.com/mcp/",
      headers: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const { useCases, rows } = fixture({ existing: remote });

    await expect(useCases.remove("github")).rejects.toThrow(/not managed/);
    expect(rows.has("github")).toBe(true);
  });

  it("refuses a name that is already taken", async () => {
    const taken: McpServer = {
      name: "image-fetch",
      url: "https://example.test/mcp",
      headers: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const { useCases, started } = fixture({ existing: taken });
    await expect(useCases.create(input)).rejects.toThrow(/already exists/);
    // nothing was started for a name that could not be registered
    expect(started).toEqual([]);
  });

  it("keeps the port the operator typed, so a restart can rebuild the spec", async () => {
    const { useCases, rows } = fixture();
    await useCases.create({ ...input, containerPort: 8080 });

    expect(rows.get("image-fetch")?.containerPort).toBe(8080);
  });
});

describe("managed MCP status", () => {
  it("separates a running container from one this app can reach", async () => {
    // The state that made this bug invisible: `docker inspect` says running,
    // and nothing answers on the address the entry holds.
    const f = fixture({ existing: managedRow() });
    f.answerWith(() => REFUSED);

    await expect(f.useCases.status("image-fetch")).resolves.toMatchObject({
      running: true,
      reachable: false,
    });
  });

  it("reports a reachable server as both", async () => {
    const f = fixture({ existing: managedRow() });

    await expect(f.useCases.status("image-fetch")).resolves.toMatchObject({
      running: true,
      reachable: true,
    });
  });

  it("does not probe a container that is not running", async () => {
    const f = fixture({ existing: managedRow(), running: false });

    await expect(f.useCases.status("image-fetch")).resolves.toMatchObject({
      running: false,
      reachable: false,
    });
    expect(f.probeCalls).toEqual([]);
  });

  it("probes with decrypted headers, on the loopback path", async () => {
    const f = fixture({ existing: managedRow({ headers: { Authorization: "enc:v1:secret" } }) });
    await f.useCases.status("image-fetch");

    expect(f.probeCalls).toEqual([
      {
        url: "http://127.0.0.1:3001/mcp",
        headers: { Authorization: "secret" },
        loopback: true,
      },
    ]);
  });
});

/**
 * The regression suite for the failure this feature actually had in production.
 *
 * A managed container joins this app's network namespace, which Docker pins to
 * the app container's id at `docker run`. Redeploying the app replaced that
 * container, and the managed one kept running — healthy, restart-policy
 * satisfied, and stranded in a namespace nothing could address. `--restart
 * unless-stopped` cannot notice, and neither could `docker inspect`.
 *
 * `tests/ssmProvisioner.test.ts` already asserted the `--network container:…`
 * flag and passed throughout. Asserting the flag was never going to catch this;
 * the bug is in the lifetime it creates, so these tests live at the level that
 * owns the repair.
 */
describe("managed MCP reconcile", () => {
  it("restarts a container that is running but unreachable", async () => {
    const f = fixture({ existing: managedRow() });
    // Unreachable until it is restarted.
    f.answerWith((_url, call) => (call === 1 ? REFUSED : REACHABLE));

    await expect(f.useCases.reconcile()).resolves.toEqual([
      { name: "image-fetch", action: "restarted" },
    ]);
    expect(f.started).toEqual(["image-fetch"]);
  });

  it("leaves a reachable server alone", async () => {
    const f = fixture({ existing: managedRow() });

    await expect(f.useCases.reconcile()).resolves.toEqual([
      { name: "image-fetch", action: "healthy" },
    ]);
    // Restarting a working server is an outage, not a repair.
    expect(f.started).toEqual([]);
  });

  it("treats a rejected credential as reached, and does not restart", async () => {
    // 401 is an answer: the server was there. Recreating the container fixes no
    // credential, and takes the server down to fail the same way.
    const f = fixture({ existing: managedRow() });
    f.answerWith(() => ({ ok: false, error: "Unauthorized", unauthorized: true }));

    await expect(f.useCases.reconcile()).resolves.toEqual([
      { name: "image-fetch", action: "healthy" },
    ]);
    expect(f.started).toEqual([]);
  });

  it("never touches a remote entry", async () => {
    const remote: McpServer = {
      name: "github",
      url: "https://api.githubcopilot.com/mcp/",
      headers: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const f = fixture({ existing: remote });
    f.answerWith(() => REFUSED);

    await expect(f.useCases.reconcile()).resolves.toEqual([]);
    expect(f.started).toEqual([]);
    // not even probed: a remote server's reachability is not this sweep's business
    expect(f.probeCalls).toEqual([]);
  });

  it("waits for a restarted container to start accepting before judging it", async () => {
    // Starting a container returns before the server inside it binds, so the
    // first probe after a restart normally fails. Reporting that as a failure
    // would cry wolf about a server that was just repaired — and a warning
    // nobody trusts is how the original outage went unnoticed for half a day.
    const f = fixture({ existing: managedRow() });
    f.answerWith((_url, call) => (call <= 2 ? REFUSED : REACHABLE));

    await expect(f.useCases.reconcile()).resolves.toEqual([
      { name: "image-fetch", action: "restarted" },
    ]);
    expect(f.started).toEqual(["image-fetch"]);
  });

  it("restarts once, then reports what still does not answer", async () => {
    const f = fixture({ existing: managedRow() });
    f.answerWith(() => REFUSED);

    await expect(f.useCases.reconcile()).resolves.toEqual([
      { name: "image-fetch", action: "failed", detail: "restarted, still unreachable" },
    ]);
    // Once. A second pass would take it down again to learn the same thing.
    expect(f.started).toEqual(["image-fetch"]);
    // and the waiting is bounded — four gaps between five attempts, then a verdict
    expect(f.sleeps).toEqual([1000, 1000, 1000, 1000]);
  });

  it("rebuilds the spec from the stored row", async () => {
    const f = fixture({
      existing: managedRow({ containerPort: 8080, envRefs: ["/agent-studio/image-fetch"] }),
    });
    f.answerWith((_url, call) => (call === 1 ? REFUSED : REACHABLE));
    await f.useCases.reconcile();

    expect(f.startedSpecs).toEqual([
      {
        name: "image-fetch",
        image: "ecr/img:v1",
        containerPort: 8080,
        envRefs: ["/agent-studio/image-fetch"],
      },
    ]);
  });

  it("restarts a row written before the port was stored", async () => {
    // Production's own entry. The adapter falls back to the port it binds.
    const legacy = managedRow();
    delete legacy.containerPort;
    const f = fixture({ existing: legacy });
    f.answerWith((_url, call) => (call === 1 ? REFUSED : REACHABLE));

    await expect(f.useCases.reconcile()).resolves.toEqual([
      { name: "image-fetch", action: "restarted" },
    ]);
    expect(f.startedSpecs).toEqual([{ name: "image-fetch", image: "ecr/img:v1" }]);
  });

  it("refuses a restart that lands somewhere other than loopback", async () => {
    const f = fixture({ existing: managedRow(), address: "http://10.0.0.7:3001" });
    f.answerWith(() => REFUSED);

    await expect(f.useCases.reconcile()).resolves.toEqual([
      { name: "image-fetch", action: "failed", detail: expect.stringContaining("loopback") },
    ]);
    expect(f.stopped).toEqual(["image-fetch"]);
    // and the entry keeps the address it had rather than the one refused
    expect(f.rows.get("image-fetch")?.url).toBe("http://127.0.0.1:3001/mcp");
  });

  it("drops the discovery cache the failure was learned into", async () => {
    const f = fixture({ existing: managedRow() });
    f.answerWith((_url, call) => (call === 1 ? REFUSED : REACHABLE));
    await f.useCases.reconcile();

    expect(f.invalidated).toContain("http://127.0.0.1:3001/mcp");
  });

  it("finishes the sweep when one entry throws", async () => {
    const f = fixture({ existing: managedRow({ name: "broken", image: undefined }) });
    f.rows.set("image-fetch", managedRow());
    f.answerWith((_url, call) => (call <= 2 ? REFUSED : REACHABLE));

    const outcomes = await f.useCases.reconcile();
    expect(outcomes.map((o) => o.name).sort()).toEqual(["broken", "image-fetch"]);
    expect(outcomes.find((o) => o.name === "broken")?.action).toBe("failed");
    // the entry after the failure was still repaired
    expect(f.started).toEqual(["image-fetch"]);
  });
});

/**
 * `restart` answers when the work is accepted, not when it is finished.
 * Everything the fixture does resolves immediately, so one macrotask turn is
 * enough for the queued work to run to completion.
 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("managed MCP restart", () => {
  it("re-creates the container and keeps the entry's address", async () => {
    const f = fixture({ existing: managedRow() });
    await f.useCases.restart("image-fetch");
    await flush();

    expect(f.started).toEqual(["image-fetch"]);
    expect(f.rows.get("image-fetch")?.url).toBe("http://127.0.0.1:3001/mcp");
  });

  it("refuses a second restart while one is still running", async () => {
    // Starting a container runs for minutes, so the operator watching an
    // unreachable server is exactly the person who presses the button again.
    // Two teardowns of one container racing is worse than saying no.
    const f = fixture({ existing: managedRow() });
    const first = f.useCases.restart("image-fetch");

    await expect(f.useCases.restart("image-fetch")).rejects.toThrow(/already running/);
    await first;
    await flush();

    expect(f.started).toEqual(["image-fetch"]);
    // and the claim is released, so the next one is allowed
    await expect(f.useCases.restart("image-fetch")).resolves.toBeUndefined();
  });

  it("releases its claim when the entry cannot be restarted at all", async () => {
    const remote: McpServer = {
      name: "github",
      url: "https://api.githubcopilot.com/mcp/",
      headers: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const f = fixture({ existing: remote });

    await expect(f.useCases.restart("github")).rejects.toThrow(/not managed/);
    // Not left claimed forever by a validation failure.
    await expect(f.useCases.restart("github")).rejects.toThrow(/not managed/);
    expect(f.started).toEqual([]);
  });

  it("stops the container it started when the entry was deleted meanwhile", async () => {
    // A sweep runs for minutes. An admin who removed an entry in that window
    // must not find it resurrected, with a container behind it.
    const f = fixture({ existing: managedRow() });
    f.answerWith(() => REFUSED);
    const restarting = f.useCases.restart("image-fetch");
    f.rows.delete("image-fetch");
    await restarting;
    await flush();

    expect(f.rows.has("image-fetch")).toBe(false);
    expect(f.stopped).toEqual(["image-fetch"]);
  });
});
