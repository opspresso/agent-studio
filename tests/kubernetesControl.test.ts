import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import type { V1Status } from "@kubernetes/client-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.hoisted(() => vi.fn());
vi.mock("@kubernetes/client-node", () => ({
  CoreV1Api: class {},
  KubeConfig: class { loadFromCluster() {} makeApiClient() { return {}; } },
  Exec: class { exec(...args: unknown[]) { return execute(...args); } },
  createConfiguration: () => ({ middleware: [] }),
}));

import { createKubernetesSandboxApi } from "@/infrastructure/workspace/kubernetesApi";

beforeEach(() => { execute.mockReset(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function respond(status: V1Status, output = "") {
  const socket = Object.assign(new EventEmitter(), { protocol: "v5.channel.k8s.io", terminate: vi.fn() });
  execute.mockImplementation((_namespace: string, _pod: string, _container: string, _argv: string[],
    stdout: Writable, stderr: Writable, stdin: Readable, _tty: boolean, callback: (status: V1Status) => void) => {
    stdin.on("data", () => {});
    stdin.on("end", () => {
      stdout.write(output);
      stderr.write("fixture-private-input");
      callback(status);
    });
    return Promise.resolve(socket);
  });
}

describe("Kubernetes control failure diagnostics", () => {
  it.each(["1", "137", "255"])("reports only the safe process exit code %s", async code => {
    respond({ status: "Failure", message: "fixture-private-input", details: { causes: [{ reason: "ExitCode", message: code }] } });
    const error = await createKubernetesSandboxApi("fixture").exec("pod", ["node", "control.mjs"], "{}", 1024)
      .then(() => undefined, error => error as Error);
    expect(error?.message).toBe(`Kubernetes Sandbox control command failed (exit code ${code})`);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, "256", "-1", "1e3", "1 fixture-private-input"])("masks untrusted or unsupported exit metadata %s", async code => {
    respond({ status: "Failure", message: "fixture-private-input", details: { causes: [{ reason: "ExitCode", message: code }] } });
    const error = await createKubernetesSandboxApi("fixture").exec("pod", ["node", "control.mjs"], "{}", 1024)
      .then(() => undefined, error => error as Error);
    expect(error?.message).toBe("Kubernetes Sandbox control command failed");
    expect(error?.message).not.toContain("fixture-private-input");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("returns bounded output after an authoritative successful exit", async () => {
    respond({ status: "Success" }, '{"ready":true}');
    await expect(createKubernetesSandboxApi("fixture").exec("pod", ["node", "control.mjs"], "{}", 1024))
      .resolves.toBe('{"ready":true}');
    expect(vi.getTimerCount()).toBe(0);
  });
});
