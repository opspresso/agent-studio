/**
 * The one runtime adapter: Docker on this app's own host, driven by SSM Run
 * Command.
 *
 * SSM rather than the Docker socket. Mounting `/var/run/docker.sock` into this
 * container would hand it root on the host, and the milestone rules it out for
 * that reason. The instance already runs the SSM agent, and the same path
 * deploys this app.
 *
 * Every value that reaches the shell is checked against a narrow pattern first.
 * The caller supplies an image reference, never a command — but "never" has to
 * be enforced here, where the string is actually assembled, or it is only a
 * comment.
 */

import {
  SSMClient,
  SendCommandCommand,
  GetCommandInvocationCommand,
} from "@aws-sdk/client-ssm";
import type {
  ManagedWorkload,
  ManagedWorkloadSpec,
  McpProvisioner,
} from "@/domain/mcp/provisioner";

/** Container/entry names are slugs, the same shape the registry already allows. */
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** `host/path:tag` or `…@sha256:…`. No spaces, quotes, or shell metacharacters. */
const IMAGE = /^[A-Za-z0-9._\-/]+(?::[A-Za-z0-9._-]+|@sha256:[a-f0-9]{64})$/;
/** SSM parameter paths this app is allowed to name. */
const ENV_REF = /^\/[A-Za-z0-9._\-/]+$/;

const POLL_INTERVAL_MS = 2_000;
const COMMAND_TIMEOUT_MS = 300_000;
/** Ports handed to managed containers. Above the ephemeral range this app uses. */
const PORT_BASE = 3100;

function assertSafe(value: string, pattern: RegExp, what: string): string {
  if (!pattern.test(value)) {
    throw new Error(`Refusing to build a command with an unsafe ${what}: ${value}`);
  }
  return value;
}

/** Deterministic per name, so a restart re-derives the port it already bound. */
function portFor(name: string): number {
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return PORT_BASE + (hash % 400);
}

export interface SsmProvisionerConfig {
  instanceId: string;
  region: string;
  /** Registry host used for `docker login`; images must come from it. */
  registry: string;
}

export function createSsmProvisioner(config: SsmProvisionerConfig): McpProvisioner {
  const client = new SSMClient({ region: config.region });

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
      const image = assertSafe(spec.image, IMAGE, "image");
      if (!image.startsWith(`${config.registry}/`)) {
        throw new Error(`Refusing an image from outside ${config.registry}: ${image}`);
      }
      const envRefs = (spec.envRefs ?? []).map((ref) => assertSafe(ref, ENV_REF, "env reference"));
      const port = portFor(name);
      const envFile = `/home/ec2-user/managed-mcp/${name}.env`;

      const out = await run([
        "set -euo pipefail",
        `mkdir -p /home/ec2-user/managed-mcp`,
        `: > ${envFile}`,
        `chmod 600 ${envFile}`,
        ...envRefs.map(
          (ref) =>
            `aws ssm get-parameter --name ${ref} --with-decryption --region ${config.region} --query Parameter.Value --output text >> ${envFile}`,
        ),
        // The container listens on its own port; only loopback is published, so
        // nothing outside this host can reach it even by mistake.
        `echo PORT=${spec.containerPort} >> ${envFile}`,
        `aws ecr get-login-password --region ${config.region} | docker login --username AWS --password-stdin ${config.registry}`,
        `docker pull -q ${image}`,
        `docker rm -f ${name} >/dev/null 2>&1 || true`,
        `docker run -d --name ${name} --restart unless-stopped --memory 512m --pids-limit 256 -p 127.0.0.1:${port}:${spec.containerPort} --env-file ${envFile} ${image} >/dev/null`,
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
        address: `http://127.0.0.1:${portFor(safe)}`,
        identity,
        running: running === "true",
        ...(detail ? { detail } : {}),
      };
    },
  };
}
