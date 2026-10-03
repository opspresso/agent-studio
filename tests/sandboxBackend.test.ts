import { describe, expect, it, vi } from "vitest";
import { createControlledSandboxBackend, type SandboxControl } from "@/infrastructure/workspace/sandboxBackend";
import { createCodingWorktree } from "@/infrastructure/workspace/gitWorktree";

describe("shared Sandbox control protocol", () => {
  it("uses the injected transport for native operations and Git without a Docker dependency", async () => {
    const calls: { id: string; action: string; request: unknown }[] = [];
    const control: SandboxControl = async <T>(id: string, action: string, request: unknown) => {
      calls.push({ id, action, request });
      return (action === "operation" ? { id: "run-1", status: "running" }
        : action === "git-review" ? { diff: "change", truncated: false }
        : action === "git-commit" ? { sha: "a".repeat(40) } : {}) as T;
    };
    const lifecycle = { ensure: vi.fn(async () => ({ externalId: "pod-uid" })),
      inspect: vi.fn(async () => "ready" as const), destroy: vi.fn(async () => {}) };
    const { provider } = createControlledSandboxBackend("kubernetes", lifecycle, control);
    await provider.start("pod-uid", "run-1", { argv: ["sh"], stdin: "echo task", timeoutMs: 1000 });
    expect(await provider.operation("pod-uid", "run-1")).toMatchObject({ status: "running" });
    await provider.cancel("pod-uid", "run-1");
    const git = createCodingWorktree(control, { webUrl: "https://git.example.test", internalHosts: [], serverToken: vi.fn() });
    expect(await git.review("pod-uid")).toMatchObject({ diff: "change" });
    expect(await git.commit("pod-uid", { operationId: "approval-1", message: "change", fingerprint: "before", ownerEmail: "owner@example.test", createdAt: "2026-09-30T00:00:00Z" })).toBe("a".repeat(40));
    expect(calls.map(call => call.action)).toEqual(["start", "operation", "cancel", "git-review", "git-commit"]);
    expect(calls.every(call => call.id === "pod-uid")).toBe(true);
  });
});
