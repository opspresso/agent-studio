/**
 * The gate in front of the three execution entry points.
 *
 * They call it *above* their own try/catch and above `withTenant`, so anything
 * it throws is a bare 500 with no body — which is what happened the moment
 * `getSessionUser` started refusing a request whose workspace it could not
 * resolve. The contract is "a principal or a Response"; every failure has to
 * come back through it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { session } = vi.hoisted(() => ({
  session: { user: null as { email: string; tenant: string } | null, throws: null as Error | null },
}));

vi.mock("@/lib/session", () => ({
  getSessionUser: async () => {
    if (session.throws) {
      throw session.throws;
    }
    return session.user;
  },
}));

vi.mock("@/infrastructure/db/client", () => ({
  getTableName: () => "test-table",
  getDocumentClient: () => ({ send: async () => ({}) }),
}));

vi.mock("@/lib/container", () => ({
  projectRepository: { getApiToken: async () => null },
  secretCipher: { decrypt: (value: string) => value },
}));

const { authenticateExecution } = await import("@/app/api/projects/_lib/executionAuth");
const { WorkspaceUnavailableError } = await import("@/lib/workspace");

const request = (headers: Record<string, string> = {}, url = "https://studio.example.com/api/x") =>
  new Request(url, { method: "POST", headers });

beforeEach(() => {
  session.user = { email: "her@example.com", tenant: "acme" };
  session.throws = null;
});

describe("a session whose workspace cannot be resolved", () => {
  it("comes back as a 503 with a body, not an unhandled throw", async () => {
    session.throws = new WorkspaceUnavailableError();
    const result = await authenticateExecution(request(), "proj");
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toMatch(/workspace/i);
  });

  it("still lets a real error surface as a 500 rather than being swallowed", async () => {
    // `apiError` maps only application errors; anything else is a bug, and a
    // bug reported as 503 tells an operator to retry something that will not
    // start working.
    session.throws = new TypeError("undefined is not a function");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = (await authenticateExecution(request(), "proj")) as Response;
    expect(response.status).toBe(500);
    error.mockRestore();
  });
});

describe("ordinary outcomes", () => {
  it("returns the caller and the workspace their session belongs to", async () => {
    expect(await authenticateExecution(request(), "proj")).toEqual({
      principal: { email: "her@example.com", viaToken: false },
      tenant: "acme",
    });
  });

  it("401s a request with no session", async () => {
    session.user = null;
    expect(((await authenticateExecution(request(), "proj")) as Response).status).toBe(401);
  });

  it("400s a bearer request naming a workspace that is not one", async () => {
    // Not 401: the credential was never looked at, and saying "unauthorized"
    // sends the caller to rotate a token that is fine.
    const response = (await authenticateExecution(
      request({ authorization: "Bearer tok", "x-tenant": "Acme Inc" }),
      "proj",
    )) as Response;
    expect(response.status).toBe(400);
  });
});
