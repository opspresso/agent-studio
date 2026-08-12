/**
 * The same port, driven by the local Docker CLI.
 *
 * For running this feature on a developer's machine, where the app and the
 * container share a loopback interface and SSM is neither present nor wanted.
 * The SSM adapter is what production uses; this one exists so the loopback path
 * can be exercised at all without an EC2 instance in the loop.
 *
 * Arguments are passed as an array, never a shell string. Pattern checks still
 * protect the values used structurally by the Docker CLI.
 */

import { execFile } from "node:child_process";
import { MANAGED_ENV_REF, MANAGED_IMAGE, managedPortFor } from "./managedPort";
import { promisify } from "node:util";
import { MANAGED_NAME } from "@/shared/slug";
import type {
  ManagedWorkload,
  ManagedWorkloadSpec,
  McpProvisioner,
} from "@/domain/mcp/provisioner";

const run = promisify(execFile);

const NAME = MANAGED_NAME;

function assertSafe(value: string, pattern: RegExp, what: string): string {
  if (!pattern.test(value)) {
    throw new Error(`Refusing an unsafe ${what}: ${value}`);
  }
  return value;
}


async function docker(args: string[]): Promise<string> {
  const { stdout } = await run("docker", args, { timeout: 300_000 });
  return stdout.trim();
}

export function createDockerProvisioner(): McpProvisioner {
  return {
    async start(spec: ManagedWorkloadSpec): Promise<ManagedWorkload> {
      const name = assertSafe(spec.name, NAME, "name");
      const image = assertSafe(spec.image, MANAGED_IMAGE, "image");
      const port = managedPortFor(name);
      // What the container is expected to listen on. Absent means the entry
      // predates persisting it, and then the only port anyone knows is the one
      // being bound — so the mapping is onto itself.
      const target = spec.containerPort ?? port;
      const args = (spec.args ?? []).map((arg) => arg.replaceAll("{{PORT}}", String(target)));
      await docker(["pull", "-q", image]).catch(() => {
        // A locally built image has nothing to pull; the run below will say so
        // if it genuinely is not there.
      });
      await docker(["rm", "-f", name]).catch(() => {});
      await docker([
        "run",
        "-d",
        "--name",
        name,
        "--restart",
        "unless-stopped",
        "--memory",
        "512m",
        "-p",
        `127.0.0.1:${port}:${target}`,
        // Say which port, rather than hope. The SSM adapter writes `PORT` into
        // the container's environment and the image obeys it; without the same
        // here, a mapping to a port nobody was told to bind publishes nothing —
        // and a container that was merely stranded comes back definitively
        // broken. `-e` beats `--env-file`, so an operator who set `PORT` there
        // and a `containerPort` that disagrees gets the one the mapping uses.
        // Checked, like the image and the name beside it. Nothing here can
        // inject a flag — this is an argv array, not a shell string — but the
        // SSM adapter has always validated the same field, and two adapters
        // disagreeing about what a reference may be is a difference neither
        // of them can justify.
        ...(spec.envRefs ?? []).flatMap((ref) => [
          "--env-file",
          assertSafe(ref, MANAGED_ENV_REF, "env reference"),
        ]),
        ...Object.entries(spec.environment ?? {}).flatMap(([key, value]) => [
          "-e",
          `${key}=${value}`,
        ]),
        "-e",
        `PORT=${target}`,
        image,
        ...args,
      ]);
      const state = await docker(["inspect", "-f", "{{.Id}} {{.State.Running}}", name]);
      const [identity = "", running = "false"] = state.split(/\s+/);
      return { name, address: `http://127.0.0.1:${port}`, identity, running: running === "true" };
    },

    async stop(name: string): Promise<void> {
      await docker(["rm", "-f", assertSafe(name, NAME, "name")]).catch(() => {});
    },

    async inspect(name: string): Promise<ManagedWorkload | null> {
      const safe = assertSafe(name, NAME, "name");
      try {
        const state = await docker([
          "inspect",
          "-f",
          "{{.Id}} {{.State.Running}} {{.State.Status}}",
          safe,
        ]);
        const [identity = "", running = "false", detail] = state.split(/\s+/);
        return {
          name: safe,
          address: `http://127.0.0.1:${managedPortFor(safe)}`,
          identity,
          running: running === "true",
          ...(detail ? { detail } : {}),
        };
      } catch {
        return null;
      }
    },
  };
}
