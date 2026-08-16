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
  networkContainer: "agentdure",
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
    expect(runLine).toContain("--network container:agentdure");
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
      ).rejects.toThrow(/unsafe/);
    }
  });

  it("refuses unsafe region and registry configuration before building commands", () => {
    expect(() =>
      createSsmProvisioner({
        instanceId: "i-1",
        region: "ap-northeast-2; id",
        registry: REGISTRY,
        networkContainer: "agentdure",
      }),
    ).toThrow(/unsafe AWS region/);
    expect(() =>
      createSsmProvisioner({
        instanceId: "i-1",
        region: "ap-northeast-2",
        registry: `${REGISTRY}; id`,
        networkContainer: "agentdure",
      }),
    ).toThrow(/unsafe registry host/);
  });

  it("pulls an image from outside this account's registry without logging in to it", async () => {
    sent.length = 0;
    await provisioner.start({
      name: "ok",
      image: "grafana/mcp-grafana:latest",
      containerPort: 8000,
    });

    const script = sent[0]?.commands.join("\n") ?? "";
    expect(script).toContain("docker pull -q grafana/mcp-grafana:latest");
    // An ECR login buys nothing for a public image, and a missing permission
    // there would fail the script before the pull that would have worked.
    expect(script).not.toContain("docker login");
  });

  it("logs in to this account's registry for an image published there", async () => {
    sent.length = 0;
    await provisioner.start({ name: "ok", image: `${REGISTRY}/x:v1`, containerPort: 3000 });

    const script = sent[0]?.commands.join("\n") ?? "";
    expect(script).toContain(`docker login --username AWS --password-stdin '${REGISTRY}'`);
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

  it("passes runtime arguments as shell-quoted container argv", async () => {
    sent.length = 0;
    await provisioner.start({
      name: "grafana",
      image: `${REGISTRY}/mcp-grafana:v1`,
      args: [
        "--transport",
        "streamable-http",
        "--address=0.0.0.0:{{PORT}}",
        "--label=it's safe; $(id)",
      ],
    });

    const script = sent[0]?.commands.join("\n") ?? "";
    const runLine = script.split("\n").find((line) => line.startsWith("docker run")) ?? "";
    expect(runLine).toContain(
      `${REGISTRY}/mcp-grafana:v1 '--transport' 'streamable-http' '--address=0.0.0.0:`,
    );
    expect(runLine).not.toContain("{{PORT}}");
    expect(runLine).toContain(`'--label=it'\"'\"'s safe; $(id)'`);
  });

  it("writes direct environment values with quoted names and values", async () => {
    sent.length = 0;
    await provisioner.start({
      name: "grafana",
      image: `${REGISTRY}/mcp-grafana:v1`,
      environment: {
        GRAFANA_URL: "https://grafana.example.com",
        GRAFANA_TOKEN: "secret'; $(id)",
      },
    });

    const script = sent[0]?.commands.join("\n") ?? "";
    expect(script).toContain(`echo 'GRAFANA_URL=https://grafana.example.com' >>`);
    expect(script).toContain(`echo 'GRAFANA_TOKEN=secret'\"'\"'; $(id)' >>`);
  });

  it("refuses an unsafe direct environment name", async () => {
    await expect(
      provisioner.start({
        name: "grafana",
        image: `${REGISTRY}/mcp-grafana:v1`,
        environment: { "TOKEN; id": "secret" },
      }),
    ).rejects.toThrow(/unsafe environment name/);
  });

  it("derives the same port for a name every time", async () => {
    // Re-discovery after a restart depends on this: the port is not stored, so
    // it has to be recomputable from the name alone.
    const a = await provisioner.inspect("image-fetch");
    const b = await provisioner.inspect("image-fetch");
    expect(a?.address).toBe(b?.address);
  });
});
