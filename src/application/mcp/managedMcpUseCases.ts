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
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  isConditionalWriteFailure,
} from "@/application/errors";
import { log } from "@/shared/logger";

export interface CreateManagedInput {
  name: string;
  image: string;
  containerPort: number;
  envRefs?: string[];
  environment?: Record<string, string>;
  args?: string[];
  endpointPath?: string;
  description?: string;
  content?: string;
  headers?: Record<string, string>;
}

export interface UpdateManagedInput {
  image?: string;
  containerPort?: number;
  envRefs?: string[];
  environment?: Record<string, string>;
  args?: string[];
  endpointPath?: string;
  description?: string;
  content?: string;
  headers?: Record<string, string>;
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
  /** `skipped` means someone else already has it; the sweep left it alone. */
  action: "healthy" | "restarted" | "failed" | "skipped";
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

/**
 * The deadline for "does anything answer".
 *
 * Short on purpose. This runs on every console page load for a managed entry and
 * on every settle attempt, and the question is only whether the server is there
 * — a container that accepts the connection and then says nothing is exactly the
 * case this feature exists to surface, so it must not be the case that stalls
 * the page for the full discovery timeout.
 */
const REACHABILITY_TIMEOUT_MS = 3_000;
const DEFAULT_ENDPOINT_PATH = "/mcp";

export interface ManagedMcpUseCases {
  create(input: CreateManagedInput): Promise<McpServer>;
  update(name: string, input: UpdateManagedInput): Promise<McpServer>;
  remove(name: string): Promise<void>;
  status(name: string): Promise<ManagedMcpStatus>;
  /**
   * Re-create one entry's container against the namespace this app has now.
   *
   * Returns once the restart has been *accepted*, not once it is done: starting
   * a container polls the runtime for minutes, and a caller that gave up
   * waiting would retry into a second teardown of the same container. Poll
   * `status` for the outcome.
   */
  restart(name: string): Promise<void>;
  /** Probe every managed entry and restart the ones that do not answer. */
  reconcile(): Promise<ReconcileOutcome[]>;
}

export function createManagedMcpUseCases(deps: ManagedMcpDeps): ManagedMcpUseCases {
  /**
   * Names with a restart in flight, held by whichever path is doing the work.
   * Two teardowns of one container racing is worse than refusing the second, and
   * an operator watching an unreachable server is exactly the person who presses
   * the button twice — or presses it while the boot sweep is already on it.
   *
   * Both paths claim here, so `restart` and `reconcile` exclude each other as
   * well as themselves. A claim is taken with no `await` between the check and
   * the add, which is what makes it a claim rather than a suggestion.
   *
   * Process-local, like the settings cache — managed servers already assume one
   * app instance per host, because a container joins exactly one namespace.
   */
  const restarting = new Set<string>();

  function view(entry: McpServer): McpServer {
    return {
      ...entry,
      headers: deps.cipher.maskHeaders(entry.headers),
      ...(entry.environment
        ? { environment: deps.cipher.maskHeaders(entry.environment) }
        : {}),
    };
  }

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
      REACHABILITY_TIMEOUT_MS,
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
      ...(entry.environment
        ? { environment: deps.cipher.decryptHeadersForOutbound(entry.environment) }
        : {}),
      ...(entry.args ? { args: entry.args } : {}),
      ...(entry.containerPort !== undefined ? { containerPort: entry.containerPort } : {}),
    };
  }

  function endpointPath(value: string | undefined): string {
    const path = value ?? DEFAULT_ENDPOINT_PATH;
    if (!/^\/(?!\/)[^\s?#]*$/.test(path)) {
      throw new ValidationError(
        "Managed MCP endpoint path must start with / and contain no query or fragment.",
      );
    }
    return path;
  }

  /**
   * The spec is passed in rather than derived here, so the caller can find out
   * that an entry cannot be started *before* it commits to starting it.
   */
  async function restartEntry(entry: McpServer, spec: ManagedWorkloadSpec): Promise<McpServer> {
    const workload = await deps.provisioner.start(spec);
    const restarted: McpServer = {
      ...entry,
      url: `${workload.address}${endpointPath(entry.endpointPath)}`,
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
    // `update`, not `put`: conditional on the row still existing. A sweep runs
    // for minutes, and an admin who deleted an entry in that window must not
    // find it resurrected — with a container behind it. If the row is gone, the
    // container we just started is the thing that should not exist.
    try {
      await deps.repo.update(restarted);
    } catch (error) {
      if (isConditionalWriteFailure(error)) {
        await deps.provisioner.stop(entry.name).catch(() => {});
        throw new NotFoundError(
          `MCP server "${entry.name}" was removed while it was being restarted; its container was stopped.`,
        );
      }
      throw error;
    }
    // Both addresses: the old one so a moved entry leaves nothing cached behind,
    // the new one so a failure learned while it was unreachable does not outlive
    // the restart. The port is derived from the name, so they are usually equal.
    deps.probe.invalidateDiscovery(entry.url);
    deps.probe.invalidateDiscovery(restarted.url);
    return restarted;
  }

  function queueRestart(entry: McpServer): void {
    void (async () => {
      try {
        if (!(await settles(await restartEntry(entry, specFor(entry))))) {
          log.warn("managed-mcp", `${entry.name}: restarted, still unreachable`);
        }
      } catch (error) {
        log.error("managed-mcp", `restart of ${entry.name} failed`, error);
      } finally {
        restarting.delete(entry.name);
      }
    })();
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
        ...(input.environment ? { environment: input.environment } : {}),
        ...(input.args ? { args: input.args } : {}),
      };
      endpointPath(input.endpointPath);
      const workload = await deps.provisioner.start(spec);
      const server: McpServer = {
        name: input.name,
        runtime: "managed",
        url: `${workload.address}${endpointPath(input.endpointPath)}`,
        image: input.image,
        containerPort: input.containerPort,
        ...(input.envRefs ? { envRefs: input.envRefs } : {}),
        ...(input.environment
          ? { environment: deps.cipher.encryptHeaders(input.environment) }
          : {}),
        ...(input.args ? { args: input.args } : {}),
        ...(input.endpointPath ? { endpointPath: input.endpointPath } : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(input.content ? { content: input.content } : {}),
        headers: deps.cipher.encryptHeaders(input.headers ?? {}),
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
      return view(server);
    },

    async update(name, input) {
      const existing = await requireManaged(name);
      const envRefs =
        input.envRefs === undefined
          ? existing.envRefs
          : input.envRefs.length > 0
            ? input.envRefs
            : undefined;
      const args =
        input.args === undefined ? existing.args : input.args.length > 0 ? input.args : undefined;
      const environment =
        input.environment === undefined
          ? existing.environment
          : Object.keys(input.environment).length > 0
            ? deps.cipher.mergeHeaderUpdate(existing.environment ?? {}, input.environment)
            : undefined;
      const nextEndpointPath = endpointPath(input.endpointPath ?? existing.endpointPath);
      const updated: McpServer = {
        ...existing,
        envRefs,
        environment,
        args,
        endpointPath:
          nextEndpointPath === DEFAULT_ENDPOINT_PATH ? undefined : nextEndpointPath,
        image: input.image ?? existing.image,
        containerPort: input.containerPort ?? existing.containerPort,
        description: input.description ?? existing.description,
        content: input.content ?? existing.content,
        headers:
          input.headers === undefined
            ? existing.headers
            : deps.cipher.mergeHeaderUpdate(existing.headers, input.headers),
        updatedAt: deps.now(),
      };
      const workloadChanged =
        updated.image !== existing.image ||
        updated.containerPort !== existing.containerPort ||
        JSON.stringify(updated.envRefs ?? []) !== JSON.stringify(existing.envRefs ?? []) ||
        JSON.stringify(updated.environment ?? {}) !== JSON.stringify(existing.environment ?? {}) ||
        JSON.stringify(updated.args ?? []) !== JSON.stringify(existing.args ?? []) ||
        nextEndpointPath !== endpointPath(existing.endpointPath);
      if (workloadChanged) {
        if (restarting.has(name)) {
          throw new ConflictError(`A restart of "${name}" is already running.`);
        }
        specFor(updated);
        restarting.add(name);
      }
      try {
        await deps.repo.update(updated);
      } catch (error) {
        restarting.delete(name);
        if (isConditionalWriteFailure(error)) {
          throw new NotFoundError(`MCP server "${name}" was removed while it was being updated.`);
        }
        throw error;
      }
      deps.probe.invalidateDiscovery(existing.url);
      if (workloadChanged) {
        queueRestart(updated);
      }
      return view(updated);
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
      if (restarting.has(name)) {
        throw new ConflictError(`A restart of "${name}" is already running.`);
      }
      // Claimed before the first await, or two clicks arriving together both
      // get past the check and tear the same container down twice.
      restarting.add(name);
      let entry: McpServer;
      try {
        entry = await requireManaged(name);
        // Built before the answer, not inside the background task. A row with
        // no image can never be started, and a 202 for that leaves the console
        // polling for minutes to learn what was knowable up front.
        specFor(entry);
      } catch (error) {
        restarting.delete(name);
        throw error;
      }
      // Everything past this point runs after the caller has been answered. The
      // work is measured in minutes; holding an HTTP response open for it means
      // a client that times out and retries, and a retry here is a second
      // teardown of the container the first one is still bringing up.
      queueRestart(entry);
    },

    async reconcile() {
      const entries = (await deps.repo.list()).filter((server) => server.runtime === "managed");
      const outcomes: ReconcileOutcome[] = [];
      // Sequential: these pull images and restart containers on one small host,
      // and a sweep that runs in the background has nothing to gain from racing
      // itself.
      for (const entry of entries) {
        // Claimed for the whole of this entry's turn, probe included. An admin
        // who presses Restart while the sweep has it gets a 409 rather than a
        // second `docker rm -f` against the container this one is bringing up —
        // and an entry already claimed by that button is left alone here for the
        // same reason.
        if (restarting.has(entry.name)) {
          outcomes.push({
            name: entry.name,
            action: "skipped",
            detail: "a restart was already running",
          });
          continue;
        }
        restarting.add(entry.name);
        try {
          if (await reaches(entry)) {
            outcomes.push({ name: entry.name, action: "healthy" });
            continue;
          }
          const restarted = await restartEntry(entry, specFor(entry));
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
        } finally {
          restarting.delete(entry.name);
        }
      }
      return outcomes;
    },
  };
}
