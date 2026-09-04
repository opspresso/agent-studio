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
import { listRegistry } from "@/application/registry/registryUseCases";
import { isManagedLoopback, type McpServer } from "@/domain/mcp/types";
import {
  MANAGED_ENDPOINT_PATH,
  type McpProvisioner,
  type ManagedWorkloadSpec,
} from "@/domain/mcp/provisioner";
import type { McpToolProbe } from "@/domain/mcp/toolProbe";
import type { SecretCipher } from "@/domain/security/secretCipher";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  isConditionalWriteFailure,
} from "@/application/errors";
import { auditTarget, recordAudit } from "@/application/audit/recordAudit";
import { stripMcpMetadataHeaders } from "@/application/mcpMetadataHeaders";
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

export type UpdateManagedInput = Partial<Omit<CreateManagedInput, "name">>;

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
  /** Process-wide in production; injectable so isolated fixtures do not share claims. */
  lifecycleClaims?: Set<string>;
}

const PROCESS_LIFECYCLE_CLAIMS = Symbol.for("opspresso.agent-studio.managed-mcp-lifecycle");

/** Shared across route bundles that operate the same host's container names. */
export function processManagedMcpLifecycleClaims(): Set<string> {
  const processGlobal = globalThis as typeof globalThis & {
    [PROCESS_LIFECYCLE_CLAIMS]?: Set<string>;
  };
  processGlobal[PROCESS_LIFECYCLE_CLAIMS] ??= new Set<string>();
  return processGlobal[PROCESS_LIFECYCLE_CLAIMS];
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
/** One host retains at most 4GiB of managed MCP memory limits. */
export const MAX_MANAGED_MCP_SERVERS = 8;
/** Not a valid managed name; serialises count-then-create across distinct names. */
const MANAGED_CREATE_CLAIM = "\0managed-create";

export interface ManagedMcpUseCases {
  create(input: CreateManagedInput): Promise<McpServer>;
  update(name: string, input: UpdateManagedInput): Promise<McpServer>;
  /**
   * `actorEmail` for the same reason `RegistryUseCases.remove` takes one: this
   * deletes a row from the shared MCP registry, and it is the row that would
   * have said anything about the entry. That it also destroys a container makes
   * the record more useful here, not less.
   */
  remove(name: string, actorEmail: string): Promise<void>;
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
   * Names with a lifecycle operation in flight, held by whichever path is doing
   * the work. Two starts or teardowns of one container racing is worse than
   * refusing the second, whether they came from create, update, a button, or the
   * boot sweep.
   *
   * Every container-changing path claims here, so they exclude each other as
   * well as themselves. A claim is taken with no `await` between the check and
   * the add, which is what makes it a claim rather than a suggestion.
   *
   * Process-wide rather than module-local because Next can evaluate route
   * bundles separately. Managed servers already assume one app process per
   * host; the database condition still arbitrates unsupported cross-process
   * writers.
   */
  const lifecycleClaims = deps.lifecycleClaims ?? processManagedMcpLifecycleClaims();

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
    // This probe has no user, project, or conversation — a stored spelling of
    // a reserved metadata header must not ride it claiming one.
    const headers = deps.cipher.decryptHeadersForOutbound(entry.headers);
    stripMcpMetadataHeaders(headers);
    const result = await deps.probe.listTools(entry.url, headers, true, REACHABILITY_TIMEOUT_MS);
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
    if (!MANAGED_ENDPOINT_PATH.test(path)) {
      throw new ValidationError(
        "Managed MCP endpoint path must start with / and contain no query or fragment.",
      );
    }
    return path;
  }

  async function stopAfterFailure(
    name: string,
    failure: unknown,
    cleanupMessage: string,
  ): Promise<void> {
    try {
      await deps.provisioner.stop(name);
    } catch (cleanupError) {
      throw new AggregateError([failure, cleanupError], cleanupMessage);
    }
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
      const failure = new ValidationError(
        `The provisioner returned ${workload.address}, which is not a loopback address.`,
      );
      await stopAfterFailure(
        entry.name,
        failure,
        `Managed MCP server "${entry.name}" restarted at an invalid address and its container could not be stopped.`,
      );
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
        const failure = new NotFoundError(
          `MCP server "${entry.name}" was removed while it was being restarted.`,
        );
        await stopAfterFailure(
          entry.name,
          failure,
          `Managed MCP server "${entry.name}" was removed during restart and its container could not be stopped.`,
        );
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
        lifecycleClaims.delete(entry.name);
      }
    })();
  }

  return {
    async create(input) {
      // Claimed before the first read. A conditional row write alone is too
      // late: two starts under one Docker name each remove what the other just
      // created, then the losing write leaves the winner's row describing the
      // wrong container.
      if (lifecycleClaims.has(input.name) || lifecycleClaims.has(MANAGED_CREATE_CLAIM)) {
        throw new ConflictError(
          `MCP server "${input.name}" already exists or has a lifecycle operation in progress`,
        );
      }
      lifecycleClaims.add(input.name);
      lifecycleClaims.add(MANAGED_CREATE_CLAIM);
      let cleanUpWorkload = false;
      try {
        if (await deps.repo.get(input.name)) {
          throw new ConflictError(`MCP server "${input.name}" already exists`);
        }
        const managedCount = (await listRegistry(deps.repo)).filter(
          (server) => server.runtime === "managed",
        ).length;
        if (managedCount >= MAX_MANAGED_MCP_SERVERS) {
          throw new ValidationError(
            `A host may run at most ${MAX_MANAGED_MCP_SERVERS} managed MCP servers.`,
          );
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
        // `start` can fail after the runtime accepted the container, so cleanup
        // is armed before it is called. `stop` treats an absent workload as
        // success.
        cleanUpWorkload = true;
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
        // deserve.
        if (!isManagedLoopback(server)) {
          throw new ValidationError(
            `The provisioner returned ${workload.address}, which is not a loopback address; the server was not registered.`,
          );
        }
        // Still conditional: another registry writer does not share this
        // process claim. Its win stops this workload rather than leaving a
        // container whose settings disagree with the stored row.
        try {
          await deps.repo.create(server);
        } catch (error) {
          if (isConditionalWriteFailure(error)) {
            throw new ConflictError(`MCP server "${input.name}" already exists`);
          }
          throw error;
        }
        cleanUpWorkload = false;
        return view(server);
      } catch (error) {
        if (cleanUpWorkload) {
          await stopAfterFailure(
            input.name,
            error,
            `Managed MCP server "${input.name}" failed to register and its container could not be stopped.`,
          );
        }
        throw error;
      } finally {
        lifecycleClaims.delete(input.name);
        lifecycleClaims.delete(MANAGED_CREATE_CLAIM);
      }
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
      let claimed = false;
      if (workloadChanged) {
        if (lifecycleClaims.has(name)) {
          throw new ConflictError(`A restart of "${name}" is already running.`);
        }
        specFor(updated);
        lifecycleClaims.add(name);
        claimed = true;
      }
      try {
        await deps.repo.update(updated);
      } catch (error) {
        if (claimed) {
          lifecycleClaims.delete(name);
        }
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

    async remove(name, actorEmail) {
      const existing = await requireManaged(name);
      // Container first. The entry is what makes it reachable, so a failure
      // after this point leaves something unreachable rather than something
      // running that nothing points at.
      await deps.provisioner.stop(name);
      await deps.repo.delete(name);
      deps.probe.invalidateDiscovery(existing.url);
      // Same action and the same `mcp:` target as an unmanaged deletion: the
      // reader is asking who removed an MCP server, and which of the two routes
      // it went through is not the question. Written here rather than in the
      // route because this is the one place the deletion happens.
      await recordAudit({
        actorEmail,
        action: "registry.delete",
        target: auditTarget("mcp", name),
        detail: "managed; its container was stopped",
      });
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
      if (lifecycleClaims.has(name)) {
        throw new ConflictError(`A restart of "${name}" is already running.`);
      }
      // Claimed before the first await, or two clicks arriving together both
      // get past the check and tear the same container down twice.
      lifecycleClaims.add(name);
      let entry: McpServer;
      try {
        entry = await requireManaged(name);
        // Built before the answer, not inside the background task. A row with
        // no image can never be started, and a 202 for that leaves the console
        // polling for minutes to learn what was knowable up front.
        specFor(entry);
      } catch (error) {
        lifecycleClaims.delete(name);
        throw error;
      }
      // Everything past this point runs after the caller has been answered. The
      // work is measured in minutes; holding an HTTP response open for it means
      // a client that times out and retries, and a retry here is a second
      // teardown of the container the first one is still bringing up.
      queueRestart(entry);
    },

    async reconcile() {
      const entries = (await listRegistry(deps.repo)).filter(
        (server) => server.runtime === "managed",
      );
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
        if (lifecycleClaims.has(entry.name)) {
          outcomes.push({
            name: entry.name,
            action: "skipped",
            detail: "a restart was already running",
          });
          continue;
        }
        lifecycleClaims.add(entry.name);
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
          lifecycleClaims.delete(entry.name);
        }
      }
      return outcomes;
    },
  };
}
