import type { SandboxProvider } from "@/domain/workspace/ports";
import { SandboxProviderError, type SandboxBackend, type SandboxControl } from "./sandboxBackend";

/** Existing Docker handles remain Docker-owned until their durable lifecycle closes them. */
export function routeSandboxBackend(primary: SandboxBackend, legacyDocker?: SandboxBackend): SandboxBackend {
  const backend = (id: string) => {
    const kind = id.startsWith("k8s:") ? "kubernetes" : /^[a-f0-9]{64}$/.test(id) ? "docker" : undefined;
    if (kind === primary.provider.kind) return primary;
    if (kind === "docker" && legacyDocker) return legacyDocker;
    throw new SandboxProviderError("Sandbox backend is unavailable for this handle; retain legacy Docker until its workspaces are drained");
  };
  const control: SandboxControl = (id, action, request, maxBytes) => backend(id).control(id, action, request, maxBytes);
  const provider: SandboxProvider = {
    kind: primary.provider.kind, ensure: id => primary.provider.ensure(id),
    inspect: id => backend(id).provider.inspect(id), execute: (id, command) => backend(id).provider.execute(id, command),
    start: (id, operationId, command) => backend(id).provider.start(id, operationId, command),
    operation: (id, operationId) => backend(id).provider.operation(id, operationId),
    output: (id, operationId, offset) => backend(id).provider.output(id, operationId, offset),
    cancel: (id, operationId) => backend(id).provider.cancel(id, operationId),
    checkpoint: id => backend(id).provider.checkpoint(id), restore: (id, bytes) => backend(id).provider.restore(id, bytes),
    destroy: id => backend(id).provider.destroy(id),
  };
  return { provider, control };
}
