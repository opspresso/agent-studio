/**
 * The one runtime adapter: Docker on this app's own host, driven by SSM Run
 * Command.
 *
 * SSM rather than the Docker socket. Mounting `/var/run/docker.sock` into this
 * container would hand it root on the host, and the milestone rules it out for
 * that reason. The instance already runs the SSM agent, and the same path
 * deploys this app.
 *
 * Structural values that reach the shell are checked against narrow patterns.
 * Runtime arguments allow ordinary punctuation, so each is single-quoted
 * independently before the command is assembled. The caller never supplies a
 * shell command.
 */

import {
  SSMClient,
  SendCommandCommand,
  GetCommandInvocationCommand,
} from "@aws-sdk/client-ssm";
import { MANAGED_NAME } from "@/shared/slug";
import { MANAGED_ENV_REF, MANAGED_IMAGE, managedPortFor } from "./managedPort";
import type {
  ManagedWorkload,
  ManagedWorkloadSpec,
  McpProvisioner,
} from "@/domain/mcp/provisioner";

/** Container/entry names are slugs, the same shape the registry already allows. */
const NAME = MANAGED_NAME;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const AWS_REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/;
const REGISTRY_HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|[A-Za-z0-9])(?::[1-9][0-9]{0,4})?$/;

const POLL_INTERVAL_MS = 2_000;
const COMMAND_TIMEOUT_MS = 300_000;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function assertSafe(value: string, pattern: RegExp, what: string): string {
  if (!pattern.test(value)) {
    throw new Error(`Refusing to build a command with an unsafe ${what}: ${value}`);
  }
  return value;
}


export interface SsmProvisionerConfig {
  instanceId: string;
  region: string;
  /**
   * Registry host `docker login` authenticates against, so images this account
   * publishes pull without a credential being typed anywhere. It is not a
   * restriction: an image from any registry the host can reach is accepted, and
   * the login is skipped for one that does not come from here.
   */
  registry: string;
  /**
   * The container whose network namespace managed workloads join.
   *
   * "Same host" is not "same loopback": every container has its own 127.0.0.1,
   * so publishing a managed server on the host's loopback leaves it unreachable
   * from this app, which is itself in a container. Joining the namespace makes
   * the address literally shared — and the port is then published nowhere at
   * all, so nothing outside that namespace can reach it either.
   *
   * Two consequences, both load-bearing. Docker resolves this name to a
   * container *id* at `docker run` and never re-resolves it, so replacing this
   * app leaves managed containers running in a namespace that no longer exists;
   * `reconcile` at boot is what repairs that, and removing it would make every
   * deploy silently break every managed server. And because a container belongs
   * to exactly one namespace, managed servers assume one app instance per host:
   * a second instance would not see them.
   */
  networkContainer: string;
}

export function createSsmProvisioner(config: SsmProvisionerConfig): McpProvisioner {
  const region = assertSafe(config.region, AWS_REGION, "AWS region");
  const registry = assertSafe(config.registry, REGISTRY_HOST, "registry host");
  const client = new SSMClient({ region });

  async function run(commands: string[]): Promise<string> {
    const sent = await client.send(
      new SendCommandCommand({
        InstanceIds: [config.instanceId],
        DocumentName: "AWS-RunShellScript",
        Parameters: { commands },
        TimeoutSeconds: 600,
      }),
    );
    const commandId = sent.Command?.CommandId;
    if (!commandId) {
      throw new Error("SSM did not return a command id");
    }
    const deadline = Date.now() + COMMAND_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      const invocation = await client.send(
        new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: config.instanceId }),
      );
      const status = invocation.Status;
      if (status === "Success") {
        return invocation.StandardOutputContent ?? "";
      }
      if (status && !["Pending", "InProgress", "Delayed"].includes(status)) {
        throw new Error(
          `SSM command ${status}: ${invocation.StandardErrorContent?.slice(0, 400) ?? "no detail"}`,
        );
      }
    }
    throw new Error("SSM command did not finish in time");
  }

  return {
    async start(spec: ManagedWorkloadSpec): Promise<ManagedWorkload> {
      const name = assertSafe(spec.name, NAME, "name");
      const image = assertSafe(spec.image, MANAGED_IMAGE, "image");
      const envRefs = (spec.envRefs ?? []).map((ref) => assertSafe(ref, MANAGED_ENV_REF, "env reference"));
      const environment = Object.entries(spec.environment ?? {}).map(
        ([key, value]) => [assertSafe(key, ENV_NAME, "environment name"), value] as const,
      );
      const port = managedPortFor(name);
      const args = (spec.args ?? []).map((arg) =>
        shellQuote(arg.replaceAll("{{PORT}}", String(port))),
      );
      const envFile = `/home/ec2-user/managed-mcp/${name}.env`;

      const out = await run([
        "set -euo pipefail",
        `mkdir -p /home/ec2-user/managed-mcp`,
        `: > ${envFile}`,
        `chmod 600 ${envFile}`,
        ...envRefs.map(
          (ref) =>
            `aws ssm get-parameter --name ${ref} --with-decryption --region ${shellQuote(region)} --query Parameter.Value --output text >> ${envFile}`,
        ),
        ...environment.map(([key, value]) => `echo ${shellQuote(`${key}=${value}`)} >> ${envFile}`),
        // In a shared namespace the container listens directly on the port the
        // entry's address names; there is no mapping to translate it.
        `echo PORT=${port} >> ${envFile}`,
        // Only for images from this account's registry. Logging in to pull a
        // public one would make a missing ECR permission look like a broken
        // image reference, and `set -e` would stop before the pull that would
        // have worked.
        ...(image.startsWith(`${registry}/`)
          ? [
              `aws ecr get-login-password --region ${shellQuote(region)} | docker login --username AWS --password-stdin ${shellQuote(registry)}`,
            ]
          : []),
        `docker pull -q ${image}`,
        `docker rm -f ${name} >/dev/null 2>&1 || true`,
        // No `-p`: ports belong to the joined namespace, and this one is meant
        // to be reachable from there and nowhere else.
        `docker run -d --name ${name} --restart unless-stopped --memory 512m --pids-limit 256 --network container:${assertSafe(config.networkContainer, NAME, "network container")} --env-file ${envFile} ${image}${args.length > 0 ? ` ${args.join(" ")}` : ""} >/dev/null`,
        `docker inspect -f '{{.Id}} {{.State.Running}}' ${name}`,
      ]);
      const [identity = "", running = "false"] = out.trim().split(/\s+/);
      return {
        name,
        address: `http://127.0.0.1:${port}`,
        identity,
        running: running === "true",
      };
    },

    async stop(name: string): Promise<void> {
      const safe = assertSafe(name, NAME, "name");
      await run([
        "set -euo pipefail",
        `docker rm -f ${safe} >/dev/null 2>&1 || true`,
        `rm -f /home/ec2-user/managed-mcp/${safe}.env`,
      ]);
    },

    async inspect(name: string): Promise<ManagedWorkload | null> {
      const safe = assertSafe(name, NAME, "name");
      const out = await run([
        `docker inspect -f '{{.Id}} {{.State.Running}} {{.State.Status}}' ${safe} 2>/dev/null || echo "absent"`,
      ]);
      const trimmed = out.trim();
      if (!trimmed || trimmed === "absent") {
        return null;
      }
      const [identity = "", running = "false", detail] = trimmed.split(/\s+/);
      return {
        name: safe,
        address: `http://127.0.0.1:${managedPortFor(safe)}`,
        identity,
        running: running === "true",
        ...(detail ? { detail } : {}),
      };
    },
  };
}
