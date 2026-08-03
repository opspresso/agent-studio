/**
 * `PUT /api/settings/workspace` validates with its own zod schema, and zod
 * strips an unlisted key rather than rejecting it — so a key present in
 * `TENANT_OVERRIDABLE_KEYS` but missing from that schema is reported by the
 * view, read by the resolution, and settable by nobody. The use case's
 * "a workspace cannot override X" check never fires, because the key is gone
 * before it looks.
 *
 * This is the third time that exact shape has appeared: `toolsRepo` on the app
 * settings route, then `unknownModelPolicy`, then this route reproducing the
 * pattern for the workspace layer. Asserting against the list rather than
 * against one more key name is what stops a fourth.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { TENANT_OVERRIDABLE_KEYS } from "@/domain/settings/types";

const { useCases } = vi.hoisted(() => ({
  useCases: { update: vi.fn(), getView: vi.fn() },
}));

vi.mock("@/lib/session", () => ({
  withAdminAuth:
    (handler: (user: unknown, ...args: never[]) => unknown) =>
    (...args: never[]) =>
      handler(
        { id: "u1", email: "admin@example.com", name: "A", image: null, tenant: "acme" },
        ...args,
      ),
}));
vi.mock("@/lib/container", () => ({ tenantSettingsUseCases: useCases }));
vi.mock("@/lib/runtime-settings", () => ({ invalidateSettingsCache: vi.fn() }));

const { PUT } = await import("@/app/api/settings/workspace/route");

const put = (body: unknown) =>
  PUT(
    new Request("https://studio.example.com/api/settings/workspace", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  useCases.update.mockResolvedValue({ tenant: "acme", fields: {} });
});

describe("PUT /api/settings/workspace", () => {
  it("accepts every key a workspace may decide", async () => {
    const body: Record<string, unknown> = {};
    for (const key of TENANT_OVERRIDABLE_KEYS) {
      // Clearing is valid for every string field, and an empty list is how the
      // provider override is cleared — so one body exercises the whole set.
      body[key] = key === "llmProviders" ? [] : "";
    }
    const response = await put(body);
    expect(response.status).toBe(200);
    expect(useCases.update).toHaveBeenCalledWith("acme", body, "admin@example.com");
  });

  it("takes the tenant from the session, never from the body", async () => {
    // A workspace admin is an admin of theirs, not of one they can name — and
    // naming one is refused rather than quietly ignored, because a caller who
    // wrote `tenant` believed it was doing something.
    expect((await put({ tenant: "globex", llmBaseUrl: "https://x" })).status).toBe(400);
    expect(useCases.update).not.toHaveBeenCalled();

    await put({ llmBaseUrl: "https://x" });
    expect(useCases.update).toHaveBeenCalledWith(
      "acme",
      { llmBaseUrl: "https://x" },
      "admin@example.com",
    );
  });

  it("refuses a key a workspace cannot override instead of dropping it", async () => {
    // The use case rejects one by name; zod's default strips unknown keys, so
    // that guard was unreachable from here and the answer was a 200 with no
    // mention of the key that will never take effect.
    const response = await put({ adminEmails: "a@b.com", llmBaseUrl: "https://x" });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain("adminEmails");
    expect(useCases.update).not.toHaveBeenCalled();
  });

  it("400s a provider list that is not one, rather than storing it", async () => {
    // `"abc".length === 3`, so an unvalidated body stored the string as the
    // provider list and broke every run in the workspace on the next read.
    expect((await put({ llmProviders: "abc" })).status).toBe(400);
    expect((await put({ llmProviders: null })).status).toBe(400);
    expect((await put({ llmBaseUrl: { a: 1 } })).status).toBe(400);
    expect(useCases.update).not.toHaveBeenCalled();
  });

  it("takes only the two model policies the dispatcher acts on", async () => {
    expect((await put({ unknownModelPolicy: "refuse" })).status).toBe(200);
    expect((await put({ unknownModelPolicy: "reufse" })).status).toBe(400);
  });
});
