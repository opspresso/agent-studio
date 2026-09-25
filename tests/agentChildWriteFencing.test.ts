import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeStore } from "./fakeStore";
import { keys } from "@/infrastructure/db/keys";

vi.mock("@/infrastructure/db/store", async () => (await import("./fakeStore")).createFakeStore());
const store = (await import("@/infrastructure/db/store")) as unknown as FakeStore;

const { agentRepository } = await import(
  "@/infrastructure/db/repositories/agentRepository"
);
const { mcpConnectionRepository } = await import(
  "@/infrastructure/db/repositories/mcpConnectionRepository"
);
const { triggerRepository } = await import(
  "@/infrastructure/db/repositories/triggerRepository"
);
const { telegramDestinationRepository } = await import(
  "@/infrastructure/db/repositories/telegramDestinationRepository"
);
const { transcriptRepository } = await import(
  "@/infrastructure/db/repositories/transcriptRepository"
);

const NOW = "2026-01-01T00:00:00.000Z";
const trigger = {
  agentName: "p",
  triggerId: "nightly",
  kind: "schedule" as const,
  description: "",
  enabled: true,
  allowConcurrent: false,
  cron: "0 0 * * *",
  timezone: "UTC",
  createdAt: NOW,
  updatedAt: NOW,
};
const run = {
  agentName: "p",
  triggerId: "nightly",
  runId: "run-1",
  status: "running" as const,
  startedAt: NOW,
};

beforeEach(() => {
  store.rows.clear();
  store.seed([
    {
      ...keys.agent("p"),
      entityType: "AGENT",
      name: "p",
      deletingAt: NOW,
    },
  ]);
});

describe("agent child write fencing", () => {
  it("rejects writes under a completed deletion tombstone", async () => {
    store.rows.clear();
    store.seed([
      {
        ...keys.agent("p"),
        entityType: "AGENT_TOMBSTONE",
        name: "p",
        deletedAt: NOW,
      },
    ]);

    await expect(
      agentRepository.setApiToken("p", { token: "enc:v1:token", createdAt: NOW }),
    ).rejects.toMatchObject({ name: store.TRANSACTION_CANCELLED });
  });

  it.each([
    [
      "API token",
      () => agentRepository.setApiToken("p", { token: "enc:v1:token", createdAt: NOW }),
    ],
    [
      "MCP connection",
      () =>
        mcpConnectionRepository.put({
          agentName: "p",
          serverName: "server",
          clientId: "client",
          issuer: "https://issuer.example",
          resource: "https://resource.example",
          scopes: [],
          status: "connected",
          updatedAt: NOW,
        }),
    ],
    ["trigger create", () => triggerRepository.create(trigger)],
    ["trigger update", () => triggerRepository.put(trigger)],
    ["trigger run start", () => triggerRepository.appendRun(run)],
    ["trigger run finish", () => triggerRepository.finishRun({ ...run, status: "succeeded" })],
    [
      "Telegram destination",
      () =>
        telegramDestinationRepository.put("p", 42, {
          chatId: 1,
          chatType: "private",
          title: "Owner",
          lastSeenAt: NOW,
        }),
    ],
    [
      "conversation transcript",
      () => transcriptRepository.append("p", "conversation", { role: "user", content: "hi", createdAt: NOW }),
    ],
  ])("rejects a %s write after agent deletion starts", async (_name, write) => {
    await expect(write()).rejects.toMatchObject({ name: store.TRANSACTION_CANCELLED });
  });
});
