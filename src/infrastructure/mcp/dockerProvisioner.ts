/**
 * The provisioner port, driven by the Docker CLI on the app's own host.
 *
 * The one runtime there is: a managed server is a container beside this app,
 * published on the host's loopback, which is what lets the registry entry
 * name `127.0.0.1`. It assumes one app instance per host — a second host
 * has no such container — and a `docker` binary the process can run (a
 * Kubernetes-native adapter would be a second implementation of the same
 * port, not a branch here).
 *
 * Arguments are passed as an array, never a shell string. Pattern checks still
 * protect the values used structurally by the Docker CLI.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MANAGED_ENV_KEY, MANAGED_ENV_REF, MANAGED_IMAGE, managedPortFor } from "./managedPort";
import { promisify } from "node:util";
import { MANAGED_NAME } from "@/domain/naming";
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
  try {
    const { stdout } = await run("docker", args, { timeout: 300_000 });
    return stdout.trim();
  } catch (error) {
    // execFile's own message repeats the whole command line, and a `docker
    // run` line used to carry every decrypted environment value. What is
    // worth keeping is what the CLI said on stderr; the argv is ours already.
    const failed = error as { stderr?: unknown; code?: unknown };
    const stderr = typeof failed.stderr === "string" ? failed.stderr.trim() : "";
    const reason =
      stderr ||
      (failed.code === "ENOENT"
        ? "the docker binary is not on this host's PATH"
        : `exit ${String(failed.code ?? "unknown")}`);
    throw new Error(`docker ${args[0] ?? ""} failed: ${reason}`);
  }
}

/**
 * The container's environment as an env-file: one `KEY=VALUE` per line, which
 * is why a value cannot hold a line break. Written to a 0600 file the CLI
 * reads at start and removed once it has — never passed as `-e KEY=VALUE`,
 * which put each secret on a command line `ps` and the error path could show.
 */
function envFileContent(environment: Record<string, string>): string {
  return Object.entries(environment)
    .map(([key, value]) => {
      assertSafe(key, MANAGED_ENV_KEY, "environment variable name");
      if (/[\r\n]/.test(value)) {
        throw new Error(`Refusing an environment value with a line break: ${key}`);
      }
      return `${key}=${value}\n`;
    })
    .join("");
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
      const environment = spec.environment ?? {};
      if (Object.keys(environment).length === 0) {
        // Nothing to hand over, so no file to write — and none to leave behind
        // if the run throws. The `--env-file` below is skipped for the same
        // reason.
        await startContainer(undefined);
      } else {
        const envDir = await mkdtemp(join(tmpdir(), "agent-studio-mcp-"));
        const envFile = join(envDir, "env");
        try {
          await writeFile(envFile, envFileContent(environment), { mode: 0o600 });
          await startContainer(envFile);
        } finally {
          await rm(envDir, { recursive: true, force: true });
        }
      }
      const state = await docker(["inspect", "-f", "{{.Id}} {{.State.Running}}", name]);
      const [identity = "", running = "false"] = state.split(/\s+/);
      return { name, address: `http://127.0.0.1:${port}`, identity, running: running === "true" };

      async function startContainer(environmentFile: string | undefined): Promise<void> {
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
        // Say which port, rather than hope. `PORT` goes into the container's
        // environment and the image obeys it; without it, a mapping to a port
        // nobody was told to bind publishes nothing —
        // and a container that was merely stranded comes back definitively
        // broken. `-e` beats `--env-file`, so an operator who set `PORT` there
        // and a `containerPort` that disagrees gets the one the mapping uses.
        // Checked, like the image and the name beside it. Nothing here can
        // inject a flag — this is an argv array, not a shell string — but a
        // reference is a path the CLI opens, and `MANAGED_ENV_REF` is where
        // what a path may look like is decided once.
        ...(spec.envRefs ?? []).flatMap((ref) => [
          "--env-file",
          assertSafe(ref, MANAGED_ENV_REF, "env reference"),
        ]),
        // After the operator's references, so an entry's own environment wins.
        ...(environmentFile !== undefined ? ["--env-file", environmentFile] : []),
        "-e",
        `PORT=${target}`,
        image,
        ...args,
      ]);
      }
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
