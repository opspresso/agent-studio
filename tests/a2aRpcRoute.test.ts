import { TaskState } from "@a2a-js/sdk";
import { ServerCallContext } from "@a2a-js/sdk/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@/domain/project/types";
import type { FakeStore } from "./fakeStore";
import { cardFixture, taskFixture, taskStatus } from "./a2aFixtures";

const { getProject, buildCard } = vi.hoisted(() => ({
  getProject: vi.fn(),
  buildCard: vi.fn(),
}));

vi.mock("@/infrastructure/db/store", async () => (await import("./fakeStore")).createFakeStore());
vi.mock("@/lib/runtime-settings", () => ({ getA2aApiKey: async () => "" }));
vi.mock("@/lib/container", async () => ({
  a2aExposureDeps: { projects: { get: getProject }, buildCard },
  a2aClientKeyUseCases: {
    verify: async (key: string) => key === "test-key" ? "test-client" : null,
    hasAny: async () => true,
  },
  createA2aTaskStore: (await import("@/infrastructure/a2a/taskStore")).createA2aTaskStore,
  executionDeps: {},
}));

const store = (await import("@/infrastructure/db/store")) as unknown as FakeStore;
const { createA2aTaskStore } = await import("@/infrastructure/a2a/taskStore");
const { POST } = await import("@/app/api/a2a/[name]/route");

const project: Project = {
  name: "helper", displayName: "Helper", description: "", projectType: "agent",
  ownerEmail: "owner@example.com", createdAt: "2026-09-22T00:00:00.000Z", updatedAt: "2026-09-22T00:00:00.000Z",
  configuration: {
    projectName: "helper", systemPrompt: "", model: "openai/gpt-5-mini",
    parameters: { piiFiltering: false }, mcpList: [], skillList: [], subagentList: [],
  },
};

function context(tenant?: string, userName = "test-client") {
  return new ServerCallContext({ tenant, user: { isAuthenticated: true, userName } });
}

async function rpc(method: string, tenant?: unknown) {
  const response = await POST(new Request("https://studio.test/api/a2a/helper", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-A2A-Key": "test-key", "A2A-Version": "1.0" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { id: "t1", tenant } }),
  }), { params: Promise.resolve({ name: "helper" }) });
  expect(response.status).toBe(200);
  return response.json();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-22T00:00:00.000Z"));
  store.rows.clear();
  getProject.mockResolvedValue(project);
  buildCard.mockResolvedValue(cardFixture(true, "https://studio.test/api/a2a/helper"));
});

afterEach(() => vi.useRealTimers());

describe("A2A JSON-RPC route tenant context", () => {
  it.each(["tenant-a", "", undefined])("reads the task in tenant %s", async (tenant) => {
    await createA2aTaskStore("helper").save(taskFixture(), context(tenant));

    await expect(rpc("GetTask", tenant)).resolves.toMatchObject({
      jsonrpc: "2.0", id: 1, result: { id: "t1", status: { state: "TASK_STATE_COMPLETED" } },
    });
  });

  it("keeps cancellation in the transport's tenant and authenticated client", async () => {
    const tasks = createA2aTaskStore("helper");
    const working = taskFixture({ status: taskStatus(TaskState.TASK_STATE_WORKING) });
    await tasks.save(working, context("tenant-a"));
    await tasks.save(working, context("tenant-b"));
    await tasks.save(working, context("tenant-a", "another-client"));

    await expect(rpc("CancelTask", "tenant-a")).resolves.toMatchObject({
      result: { id: "t1", status: { state: "TASK_STATE_CANCELED" } },
    });
    expect((await tasks.load("t1", context("tenant-a")))?.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    expect((await tasks.load("t1", context("tenant-b")))?.status?.state).toBe(TaskState.TASK_STATE_WORKING);
    expect((await tasks.load("t1", context("tenant-a", "another-client")))?.status?.state).toBe(TaskState.TASK_STATE_WORKING);
  });

  it("does not read a task from another tenant or client", async () => {
    const tasks = createA2aTaskStore("helper");
    await tasks.save(taskFixture(), context("tenant-a"));
    await tasks.save(taskFixture(), context("tenant-b", "another-client"));

    await expect(rpc("GetTask", "tenant-b")).resolves.toMatchObject({ error: { code: -32001 } });
  });

  it.each([7, true, null, {}, []].map(tenant => ({ tenant })))(
    "rejects a non-string tenant $tenant before dispatch",
    async ({ tenant }) => {
      await expect(rpc("GetTask", tenant)).resolves.toMatchObject({ error: { code: -32602 } });
    },
  );
});
