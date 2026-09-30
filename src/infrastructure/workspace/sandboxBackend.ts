import { randomUUID } from "node:crypto";
import type { SandboxProvider, SandboxCommandResult } from "@/domain/workspace/ports";
import { WORKSPACE_LIMITS } from "@/domain/workspace/limits";

export class SandboxProviderError extends Error {}

/** Root-only control transport shared by compute and server-side Git operations. */
export type SandboxControl = <T>(externalId: string, action: string, request: unknown, maxBytes?: number) => Promise<T>;
export interface SandboxBackend {
  provider: SandboxProvider;
  control: SandboxControl;
}

export function createControlledSandboxBackend(
  kind: string,
  lifecycle: Pick<SandboxProvider, "ensure" | "inspect" | "destroy" | "provision">,
  control: SandboxControl,
): SandboxBackend {
  return { control, provider: {
    kind, ...lifecycle,
    async start(id, operationId, command) { await control(id, "start", { id: operationId, command }); },
    async operation(id, operationId) { return control(id, "operation", { id: operationId }); },
    async output(id, operationId, offset) {
      const result = await control<{ text: string; nextOffset: number }>(id, "output", { id: operationId, offset });
      return { frames: result.text.split("\n").filter(Boolean).map(line => {
        const frame = JSON.parse(line) as { stream: "stdout" | "stderr"; text: string };
        if (!["stdout", "stderr"].includes(frame.stream) || typeof frame.text !== "string") throw new SandboxProviderError("Invalid sandbox output");
        return frame;
      }), nextOffset: result.nextOffset };
    },
    async cancel(id, operationId) { await control(id, "cancel", { id: operationId }); },
    execute: (id, command) => control<SandboxCommandResult>(id, "execute", { id: `exec-${randomUUID()}`, command }),
    async checkpoint(id) {
      const result = await control<{ bytes: string }>(id, "checkpoint", {}, Math.ceil(WORKSPACE_LIMITS.checkpointBytes * 4 / 3) + 1000);
      if (typeof result.bytes !== "string" || Buffer.byteLength(result.bytes, "base64") > WORKSPACE_LIMITS.checkpointBytes) {
        throw new SandboxProviderError("Invalid sandbox checkpoint");
      }
      return Buffer.from(result.bytes, "base64");
    },
    async restore(id, checkpoint) {
      if (checkpoint.byteLength > WORKSPACE_LIMITS.checkpointBytes) throw new SandboxProviderError("Workspace checkpoint exceeds storage limit");
      await control(id, "restore", { bytes: Buffer.from(checkpoint).toString("base64") });
    },
  } };
}
