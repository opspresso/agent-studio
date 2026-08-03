/**
 * The record points that need a route around them: revealing the app-wide A2A
 * key, and deleting a shared registry entry.
 *
 * The token, override, project-delete and settings points are exercised next to
 * their own use cases (`auditLog.test.ts`, `settingsUseCases.test.ts`).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEvent } from "@/domain/audit/types";

const { authMock, fakeClient } = vi.hoisted(() => ({
  authMock: { getSession: vi.fn() },
  // Answers a Get with a stored skill so the delete actually succeeds; every
  // other command is a no-op. A 404 would record nothing, which is the case
  // this test must not silently become.
  fakeClient: {
    async send(command: { constructor: { name: string } }) {
      return command.constructor.name === "GetCommand"
        ? { Item: { name: "demo", description: "d", content: "", createdAt: "", updatedAt: "" } }
        : {};
    },
  },
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: authMock.getSession } } }));
vi.mock("@/infrastructure/db/client", () => ({
  getDocumentClient: () => fakeClient,
  getTableName: () => "test-table",
}));

// Imported at module scope, before `beforeEach` wires the sink: loading the
// registry route pulls in the composition root, which wires the *real* sink on
// import. A route imported inside a test would therefore clobber the fake.
const { POST: revealA2aKey } = await import("@/app/api/settings/a2a-key/reveal/route");
const { DELETE: deleteSkill } = await import("@/app/api/skills/[name]/route");
const { setAuditSink } = await import("@/application/audit/auditLog");

const recorded: AuditEvent[] = [];
const ADMIN = "boss@example.com";

beforeEach(() => {
  recorded.length = 0;
  setAuditSink(async (event) => {
    recorded.push(event);
  });
  authMock.getSession.mockResolvedValue({
    user: { id: "u1", email: ADMIN, name: "Boss", image: null },
  });
  process.env.ADMIN_EMAILS = ADMIN;
});

describe("A2A key", () => {
  it("records a reveal, naming who saw the key and never the key", async () => {
    process.env.A2A_API_KEY = "asa_secret-value";
    const response = await revealA2aKey();
    expect(response.status).toBe(200);
    expect(recorded).toEqual([
      expect.objectContaining({
        action: "secret.reveal",
        actorEmail: ADMIN,
        target: "settings:a2a-key",
      }),
    ]);
    // The trail says a credential was seen; it is not a second copy of it.
    expect(JSON.stringify(recorded)).not.toContain("asa_secret-value");
  });
});

describe("registry deletes", () => {
  it("records which shared entry was removed, and by whom", async () => {
    const response = await deleteSkill(
      new Request("http://x/api/skills/demo", { method: "DELETE" }),
      { params: Promise.resolve({ name: "demo" }) },
    );

    expect(response.status).toBe(204);
    expect(recorded).toEqual([
      expect.objectContaining({
        action: "registry.delete",
        actorEmail: ADMIN,
        target: "skill:demo",
      }),
    ]);
  });
});
