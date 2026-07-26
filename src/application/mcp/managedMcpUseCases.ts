/**
 * Managed MCP servers: the registry entry and the container are one thing, so
 * they are created and destroyed together.
 *
 * The address is the seam. A managed entry is trusted because the provisioner
 * reported where it bound the port, so that value is written here and nowhere
 * else — `mcpUseCases` refuses to move it, and `isManagedLoopback` refuses to
 * believe it if it is not loopback.
 */

import type { McpRepository } from "@/domain/mcp/repository";
import { isManagedLoopback, type McpServer } from "@/domain/mcp/types";
import type { McpProvisioner, ManagedWorkloadSpec } from "@/domain/mcp/provisioner";
import type { McpToolProbe } from "@/domain/mcp/toolProbe";
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
  address?: string;
  detail?: string;
}

export interface ManagedMcpDeps {
  repo: McpRepository;
  provisioner: McpProvisioner;
  probe: McpToolProbe;
  now: () => string;
}

/** The path suffix every server this app starts is expected to serve. */
const MCP_PATH = "/mcp";

export interface ManagedMcpUseCases {
  create(input: CreateManagedInput): Promise<McpServer>;
  remove(name: string): Promise<void>;
  status(name: string): Promise<ManagedMcpStatus>;
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
      return {
        name,
        ...(existing.image ? { image: existing.image } : {}),
        running: workload?.running ?? false,
        ...(workload?.address ? { address: workload.address } : {}),
        ...(workload?.detail ? { detail: workload.detail } : {}),
      };
    },
  };
}
