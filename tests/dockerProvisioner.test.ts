import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The provisioner drives the Docker CLI. What these pin is how a managed
 * server's environment travels — a 0600 file the CLI reads, never the command
 * line — and what a failure says: the CLI's stderr, never the argv that used
 * to repeat every decrypted value into the process log.
 */
const cli = vi.hoisted(() => ({
  calls: [] as string[][],
  envFileSeen: null as null | { mode: number; content: string },
  fail: null as null | Record<string, unknown>,
}));

vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const { readFile, stat } = await import("node:fs/promises");
  const execFile = Object.assign(vi.fn(), {
    [promisify.custom]: async (_command: string, args: string[]) => {
      cli.calls.push(args);
      if (args[0] === "run") {
        const at = args.lastIndexOf("--env-file");
        const path = at >= 0 ? args[at + 1] : undefined;
        if (path?.includes("agent-studio-mcp-")) {
          cli.envFileSeen = {
            mode: (await stat(path)).mode & 0o777,
            content: await readFile(path, "utf8"),
          };
        }
        if (cli.fail) {
          throw Object.assign(new Error(`Command failed: docker ${args.join(" ")}`), cli.fail);
        }
      }
      return { stdout: args[0] === "inspect" ? "abc123 true" : "", stderr: "" };
    },
  });
  return { execFile };
});

const { createDockerProvisioner } = await import("@/infrastructure/mcp/dockerProvisioner");

const spec = {
  name: "my-tool",
  image: "ghcr.io/acme/my-mcp:1.0.0",
  containerPort: 8080,
  environment: { API_KEY: "s3cret-value" },
};

beforeEach(() => {
  cli.calls = [];
  cli.envFileSeen = null;
  cli.fail = null;
});

describe("docker provisioner", () => {
  it("hands the environment over as a 0600 env-file, never on the command line", async () => {
    const workload = await createDockerProvisioner().start(spec);
    expect(workload.running).toBe(true);
    const run = cli.calls.find((args) => args[0] === "run")!;
    expect(run.join(" ")).not.toContain("s3cret-value");
    expect(cli.envFileSeen).toEqual({ mode: 0o600, content: "API_KEY=s3cret-value\n" });
    // `-e PORT` still beats the file, as the mapping requires.
    expect(run).toContain("PORT=8080");
  });

  it("reports the CLI's stderr on failure, without the argv that carried secrets", async () => {
    cli.fail = { stderr: "Unable to find image 'ghcr.io/acme/my-mcp:1.0.0' locally\n", code: 125 };
    const failure = await createDockerProvisioner().start(spec).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/^docker run failed: Unable to find image/);
    expect((failure as Error).message).not.toContain("s3cret-value");
  });

  it("names a missing binary", async () => {
    cli.fail = { code: "ENOENT" };
    await expect(createDockerProvisioner().start(spec)).rejects.toThrow(/docker binary is not on/);
  });

  it("refuses a value the env-file format cannot carry, naming only the key", async () => {
    await expect(
      createDockerProvisioner().start({ ...spec, environment: { TOKEN: "two\nlines" } }),
    ).rejects.toThrow(/line break: TOKEN$/);
  });
});
