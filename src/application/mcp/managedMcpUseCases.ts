/**
 * Managed MCP servers: the registry entry and the container are one thing, so
 * they are created and destroyed together.
 *
 * The address is the seam. A managed entry is trusted because the provisioner
 * reported where it bound the port, so that value is written here and nowhere
 * else — `mcpUseCases` refuses to move it, and `isManagedLoopback` refuses to
 * believe it if it is not loopback.
 *
 * Reachability, not liveness, is what says a managed server works. A container
 * joins this app's network namespace when it starts, and Docker pins that to the
 * app container's *identity*, not its name — so replacing this app leaves the
 * container running perfectly in a namespace nothing can address any more.
 * `docker inspect` still calls it healthy. Only asking the server tells them
 * apart, which is why `status` probes and `reconcile` restarts what does not
 * answer.
 */

import type { McpRepository } from "@/domain/mcp/repository";
import { isManagedLoopback, type McpServer } from "@/domain/mcp/types";
import type { McpProvisioner, ManagedWorkloadSpec } from "@/domain/mcp/provisioner";
import type { McpToolProbe } from "@/domain/mcp/toolProbe";
import type { SecretCipher } from "@/domain/security/secretCipher";
import { ConflictError, NotFoundError, ValidationError } from "@/application/errors";

export interface CreateManagedInput {
  name: string;
  image: string;
  containerPort: number;
  envRefs?: string[];
  description?: string;
}

export interface ManagedMcpStatus {
  name: string;
  image?: string;
  running: boolean;
  /**
   * The server answered. Separate from `running` on purpose: "running and
   * unreachable" is a real state, and reporting only the first is what let a
   * stranded container look healthy for half a day.
   */
  reachable: boolean;
  address?: string;
  detail?: string;
}

/** What one entry needed, for the caller that has to report a sweep. */
export interface ReconcileOutcome {
  name: string;
  action: "healthy" | "restarted" | "failed";
  detail?: string;
}

export interface ManagedMcpDeps {
  repo: McpRepository;
  provisioner: McpProvisioner;
  probe: McpToolProbe;
  cipher: SecretCipher;
  now: () => string;
  /** Injected so tests settle instantly and stay deterministic. */
  sleep: (ms: number) => Promise<void>;
}

/** The path suffix every server this app starts is expected to serve. */
const MCP_PATH = "/mcp";

/**
 * How long a just-restarted container gets to start accepting.
 *
 * Starting one returns as soon as the runtime has the process, which is before
 * the server inside it binds. Probing once and calling that a failure would
 * report a server we had just fixed as broken — and a warning that cries wolf is
 * how the outage this whole path exists to prevent stayed invisible for half a
 * day. Bounded, because the point is to stop guessing, not to wait forever.
 */
const SETTLE_ATTEMPTS = 5;
const SETTLE_INTERVAL_MS = 1_000;

export interface ManagedMcpUseCases {
  create(input: CreateManagedInput): Promise<McpServer>;
  remove(name: string): Promise<void>;
  status(name: string): Promise<ManagedMcpStatus>;
  /** Re-create one entry's container against the namespace this app has now. */
  restart(name: string): Promise<McpServer>;
  /** Probe every managed entry and restart the ones that do not answer. */
  reconcile(): Promise<ReconcileOutcome[]>;
}

export function createManagedMcpUseCases(deps: ManagedMcpDeps): ManagedMcpUseCases {
  async function requireManaged(name: string): Promise<McpServer> {
    const existing = await deps.repo.get(name);
    if (!existing) {
      throw new NotFoundError(`MCP server "${name}" not found`);
    }
    if (existing.runtime !== "managed") {
      throw new ValidationError(`MCP server "${name}" is not managed by this app.`);
    }
    return existing;
  }

  /**
   * Did the server answer? Not "is it healthy" — a 401 counts, because the
   * server was there to reject the credential. Restarting a container over a
   * credential problem fixes nothing and takes the server down to do it.
   */
  async function reaches(entry: McpServer): Promise<boolean> {
    // A managed row that is not loopback is a bug or tampering. It is not
    // something to probe with the outbound guard bypassed, and the restart path
    // is what puts a real address back on it.
    if (!isManagedLoopback(entry)) {
      return false;
    }
    const result = await deps.probe.listTools(
      entry.url,
      deps.cipher.decryptHeadersForOutbound(entry.headers),
      true,
    );
    return result.ok || result.unauthorized === true;
  }

  /** Reachable, allowing for a container that is still on its way up. */
  async function settles(entry: McpServer): Promise<boolean> {
    for (let attempt = 1; attempt <= SETTLE_ATTEMPTS; attempt += 1) {
      if (await reaches(entry)) {
        return true;
      }
      if (attempt < SETTLE_ATTEMPTS) {
        await deps.sleep(SETTLE_INTERVAL_MS);
      }
    }
    return false;
  }

  /**
   * The spec an entry was created from, rebuilt from the row. Everything the
   * provisioner needs is stored, because at restart time there is no operator
   * to ask again.
   */
  function specFor(entry: McpServer): ManagedWorkloadSpec {
    if (!entry.image) {
      throw new ValidationError(
        `MCP server "${entry.name}" has no image recorded, so there is nothing to start.`,
      );
    }
    return {
      name: entry.name,
      image: entry.image,
      ...(entry.envRefs ? { envRefs: entry.envRefs } : {}),
      ...(entry.containerPort !== undefined ? { containerPort: entry.containerPort } : {}),
    };
  }

  async function restartEntry(entry: McpServer): Promise<McpServer> {
    const workload = await deps.provisioner.start(specFor(entry));
    const restarted: McpServer = {
      ...entry,
      url: `${workload.address}${MCP_PATH}`,
      updatedAt: deps.now(),
    };
    // The same guard `create` applies, for the same reason: the provisioner is
    // the only source of this address, but it is not the only thing that must
    // agree it is safe.
    if (!isManagedLoopback(restarted)) {
      await deps.provisioner.stop(entry.name).catch(() => {});
      throw new ValidationError(
        `The provisioner returned ${workload.address}, which is not a loopback address; the container was stopped rather than left behind an entry that cannot point at it.`,
      );
    }
    await deps.repo.put(restarted);
    // Both addresses: the old one so a moved entry leaves nothing cached behind,
    // the new one so a failure learned while it was unreachable does not outlive
    // the restart. The port is derived from the name, so they are usually equal.
    deps.probe.invalidateDiscovery(entry.url);
    deps.probe.invalidateDiscovery(restarted.url);
    return restarted;
  }

  return {
    async create(input) {
      if (await deps.repo.get(input.name)) {
        throw new ConflictError(`MCP server "${input.name}" already exists`);
      }
      const spec: ManagedWorkloadSpec = {
        name: input.name,
        image: input.image,
        containerPort: input.containerPort,
        ...(input.envRefs ? { envRefs: input.envRefs } : {}),
      };
      const workload = await deps.provisioner.start(spec);
      const server: McpServer = {
        name: input.name,
        runtime: "managed",
        url: `${workload.address}${MCP_PATH}`,
        image: input.image,
        containerPort: input.containerPort,
        ...(input.envRefs ? { envRefs: input.envRefs } : {}),
        ...(input.description ? { description: input.description } : {}),
        headers: {},
        createdAt: deps.now(),
        updatedAt: deps.now(),
      };
      // The provisioner is the only source of this address, but it is not the
      // only thing that must agree it is safe. If what came back is not
      // loopback, the entry would be stored carrying a bypass it does not
      // deserve — so it is refused here, and the container it named is stopped
      // rather than left running behind a row that was never written.
      if (!isManagedLoopback(server)) {
        await deps.provisioner.stop(input.name).catch(() => {});
        throw new ValidationError(
          `The provisioner returned ${workload.address}, which is not a loopback address; the server was not registered.`,
        );
      }
      // `create` rather than `put`: a conditional write, so two operators
      // pressing the button together produce one entry, not two.
      await deps.repo.create(server);
      return server;
    },

    async remove(name) {
      const existing = await requireManaged(name);
      // Container first. The entry is what makes it reachable, so a failure
      // after this point leaves something unreachable rather than something
      // running that nothing points at.
      await deps.provisioner.stop(name);
      await deps.repo.delete(name);
      deps.probe.invalidateDiscovery(existing.url);
    },

    async status(name) {
      const existing = await requireManaged(name);
      const workload = await deps.provisioner.inspect(name);
      const running = workload?.running ?? false;
      return {
        name,
        ...(existing.image ? { image: existing.image } : {}),
        running,
        // A container that is not running cannot answer, and probing it would
        // only buy the console a timeout.
        reachable: running ? await reaches(existing) : false,
        ...(workload?.address ? { address: workload.address } : {}),
        ...(workload?.detail ? { detail: workload.detail } : {}),
      };
    },

    async restart(name) {
      const restarted = await restartEntry(await requireManaged(name));
      // The same grace the sweep gives, so the status the console fetches next
      // is a settled one rather than a container caught mid-boot.
      await settles(restarted);
      return restarted;
    },

    async reconcile() {
      const entries = (await deps.repo.list()).filter((server) => server.runtime === "managed");
      const outcomes: ReconcileOutcome[] = [];
      // Sequential: these pull images and restart containers on one small host,
      // and a sweep that runs in the background has nothing to gain from racing
      // itself.
      for (const entry of entries) {
        try {
          if (await reaches(entry)) {
            outcomes.push({ name: entry.name, action: "healthy" });
            continue;
          }
          const restarted = await restartEntry(entry);
          // One restart per entry per sweep. If it still does not answer once
          // it has had time to come up, the problem is not the namespace it was
          // stranded in, and going round again would only take it down a second
          // time to prove that.
          outcomes.push(
            (await settles(restarted))
              ? { name: entry.name, action: "restarted" }
              : {
                  name: entry.name,
                  action: "failed",
                  detail: "restarted, still unreachable",
                },
          );
        } catch (error) {
          // One entry's failure must not end the sweep: the next one may be the
          // one that was actually stranded.
          outcomes.push({
            name: entry.name,
            action: "failed",
            detail: error instanceof Error ? error.message : "restart failed",
          });
        }
      }
      return outcomes;
    },
  };
}
