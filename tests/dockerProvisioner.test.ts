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
  failCommand: "run",
  owner: "true",
  ownerName: "my-tool",
  absentBeforeStart: false,
  missingLocalImage: false,
}));

vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const { readFile, stat } = await import("node:fs/promises");
  const execFile = Object.assign(vi.fn(), {
    [promisify.custom]: async (_command: string, args: string[]) => {
      cli.calls.push(args);
      if (cli.absentBeforeStart && args[0] === "inspect" && args.at(-1) === "my-tool") {
        throw { stderr: "Error: No such container: my-tool", code: 1 };
      }
      if (cli.missingLocalImage && args[0] === "image") throw { stderr: "No such image", code: 1 };
      if (args[0] === "run") {
        const at = args.lastIndexOf("--env-file");
        const path = at >= 0 ? args[at + 1] : undefined;
        if (path?.includes("agent-studio-mcp-")) {
          cli.envFileSeen = {
            mode: (await stat(path)).mode & 0o777,
            content: await readFile(path, "utf8"),
          };
        }
      }
      if (cli.fail && args[0] === cli.failCommand) {
        throw Object.assign(new Error(`Command failed: docker ${args.join(" ")}`), cli.fail);
      }
      return { stdout: args[0] === "inspect" ? `${"a".repeat(64)} true running ${cli.owner} ${cli.ownerName}`
        : args[0] === "run" ? "a".repeat(64) : "", stderr: "" };
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
  cli.failCommand = "run";
  cli.owner = "true";
  cli.ownerName = "my-tool";
  cli.absentBeforeStart = false;
  cli.missingLocalImage = false;
});

describe("docker provisioner", () => {
  it("creates a labeled container when the name is free", async () => {
    cli.absentBeforeStart = true;
    await expect(createDockerProvisioner().start(spec)).resolves.toMatchObject({ identity: "a".repeat(64), running: true });
    expect(cli.calls.some(args => args[0] === "rm")).toBe(false);
    expect(cli.calls.find(args => args[0] === "run")).toContain("agent-studio.mcp-name=my-tool");
  });

  it("refuses an unlabeled container without removing it", async () => {
    cli.owner = "";
    cli.ownerName = "";
    await expect(createDockerProvisioner().stop(spec.name)).rejects.toThrow("not owned by this managed MCP server");
    expect(cli.calls.some(args => args[0] === "rm")).toBe(false);
  });

  it.each(["start", "stop", "inspect"] as const)("refuses an unowned container during %s", async operation => {
    cli.owner = "false";
    const provisioner = createDockerProvisioner();
    await expect(operation === "start" ? provisioner.start(spec) : provisioner[operation](spec.name))
      .rejects.toThrow("not owned by this managed MCP server");
    expect(cli.calls.some(args => ["rm", "run", "pull"].includes(args[0]!))).toBe(false);
  });

  it("refuses another managed server's container", async () => {
    cli.ownerName = "other-tool";
    await expect(createDockerProvisioner().stop(spec.name)).rejects.toThrow("not owned by this managed MCP server");
    expect(cli.calls.some(args => args[0] === "rm")).toBe(false);
  });

  it("can use a local image when the registry is unavailable", async () => {
    cli.failCommand = "pull";
    cli.fail = { stderr: "registry unavailable", code: 1 };
    await expect(createDockerProvisioner().start(spec)).resolves.toMatchObject({ running: true });
    expect(cli.calls).toContainEqual(["image", "inspect", "--format", "{{.Id}}", spec.image]);
  });

  it("preserves the existing container when the replacement image is unavailable", async () => {
    cli.failCommand = "pull";
    cli.fail = { stderr: "registry unavailable", code: 1 };
    cli.missingLocalImage = true;
    await expect(createDockerProvisioner().start(spec)).rejects.toThrow("docker pull failed: registry unavailable");
    expect(cli.calls.some(args => args[0] === "rm" || args[0] === "run")).toBe(false);
  });

  it("hands the environment over as a 0600 env-file, never on the command line", async () => {
    const workload = await createDockerProvisioner().start(spec);
    expect(workload.running).toBe(true);
    const run = cli.calls.find((args) => args[0] === "run")!;
    expect(run.join(" ")).not.toContain("s3cret-value");
    expect(cli.envFileSeen).toEqual({ mode: 0o600, content: "API_KEY=s3cret-value\n" });
    expect(run).toEqual(
      expect.arrayContaining([
        "--memory",
        "512m",
        "--memory-swap",
        "512m",
        "--cpus",
        "1",
        "--pids-limit",
        "256",
        "--security-opt",
        "no-new-privileges",
        "--cap-drop",
        "ALL",
        "--read-only",
        "agent-studio.managed-mcp=true",
        "agent-studio.mcp-name=my-tool",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=64m",
      ]),
    );
    // `-e PORT` still beats the file, as the mapping requires.
    expect(run).toContain("PORT=8080");
    expect(cli.calls.find(args => args[0] === "rm")).toEqual(["rm", "-f", "a".repeat(64)]);
    expect(cli.calls.filter(args => args[0] === "inspect").at(-1)?.at(-1)).toBe("a".repeat(64));
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
    expect(cli.calls).toEqual([]);
  });

  it("does not launch a replacement when removing the owned container fails", async () => {
    cli.failCommand = "rm";
    cli.fail = { stderr: "permission denied", code: 1 };
    await expect(createDockerProvisioner().start(spec)).rejects.toThrow("docker rm failed: permission denied");
    expect(cli.calls.some(args => args[0] === "run")).toBe(false);
  });

  it("refuses a control character in argv without echoing the argument", async () => {
    const failure = await createDockerProvisioner()
      .start({ ...spec, args: ["--token=secret\nnext"] })
      .catch((error: Error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Refusing an unsafe container argument");
    expect((failure as Error).message).not.toContain("secret");
  });

  it("treats an already absent container as stopped", async () => {
    cli.failCommand = "rm";
    cli.fail = { stderr: "Error response from daemon: No such container: my-tool\n", code: 1 };

    await expect(createDockerProvisioner().stop("my-tool")).resolves.toBeUndefined();
  });

  it("reports a real remove failure instead of claiming the container stopped", async () => {
    cli.failCommand = "rm";
    cli.fail = { stderr: "permission denied while trying to connect to the Docker daemon\n", code: 1 };

    await expect(createDockerProvisioner().stop("my-tool")).rejects.toThrow(
      /docker rm failed: permission denied/,
    );
  });

  it("returns no workload when inspect says the container is absent", async () => {
    cli.failCommand = "inspect";
    cli.fail = { stderr: "Error: No such container: my-tool\n", code: 1 };

    await expect(createDockerProvisioner().inspect("my-tool")).resolves.toBeNull();
  });

  it("reports a real inspect failure instead of calling the container absent", async () => {
    cli.failCommand = "inspect";
    cli.fail = { stderr: "permission denied while trying to connect to the Docker daemon\n", code: 1 };

    await expect(createDockerProvisioner().inspect("my-tool")).rejects.toThrow(
      /docker inspect failed: permission denied/,
    );
  });
});
