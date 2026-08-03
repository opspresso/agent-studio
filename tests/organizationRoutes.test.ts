/**
 * Which authority each workspace route consults.
 *
 * The two are not interchangeable and the whole point of separating them is
 * here: registering or deleting a workspace changes what the *deployment* is —
 * an id becomes a key prefix — while managing members is the workspace's own
 * business. A workspace admin reaching the first would be able to mint and
 * destroy namespaces they have nothing to do with.
 *
 * The predicates themselves are exercised against real membership rows in
 * `workspaceAuthz.test.ts`; what this pins is which one each verb asks.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { gates, useCases } = vi.hoisted(() => ({
  gates: { deployment: false, workspaceAdminOf: new Set<string>() },
  useCases: {
    list: vi.fn(),
    create: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
    listMembers: vi.fn(),
    setMember: vi.fn(),
    removeMember: vi.fn(),
  },
}));

const CALLER = { id: "u1", email: "her@example.com", name: "Her", image: null, tenant: "acme" };

vi.mock("@/lib/session", () => ({
  withAuth:
    (handler: (user: unknown, ...args: never[]) => unknown) =>
    (...args: never[]) =>
      handler(CALLER, ...args),
  withDeploymentAdminAuth:
    (handler: (user: unknown, ...args: never[]) => unknown) =>
    (...args: never[]) => {
      if (!gates.deployment) {
        return Response.json(
          { error: "Only a deployment administrator can access this resource" },
          { status: 403 },
        );
      }
      return handler(CALLER, ...args);
    },
  isDeploymentAdmin: async () => gates.deployment,
}));

vi.mock("@/lib/workspace", () => ({
  isAdminOfOrganization: async (_email: string, id: string) => gates.workspaceAdminOf.has(id),
  invalidateWorkspaceCache: () => {},
}));

vi.mock("@/lib/container", () => ({ organizationUseCases: useCases }));

const { GET: listOrganizations, POST: createOrganization } = await import(
  "@/app/api/organizations/route"
);
const { DELETE: deleteOrganization, PATCH: renameOrganization } = await import(
  "@/app/api/organizations/[id]/route"
);
const { GET: listMembers, PUT: setMember } = await import(
  "@/app/api/organizations/[id]/members/route"
);

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const body = (value: unknown, method = "PUT") =>
  new Request("https://studio.example.com/api/organizations", {
    method,
    body: JSON.stringify(value),
  });

beforeEach(() => {
  vi.clearAllMocks();
  gates.deployment = false;
  gates.workspaceAdminOf.clear();
  useCases.list.mockResolvedValue([
    { id: "acme", displayName: "Acme", createdAt: "", updatedAt: "" },
    { id: "globex", displayName: "Globex", createdAt: "", updatedAt: "" },
  ]);
  useCases.listMembers.mockResolvedValue([]);
  useCases.setMember.mockResolvedValue({ organizationId: "acme", userEmail: "x@y.z", role: "viewer" });
  useCases.create.mockResolvedValue({ id: "new", displayName: "New" });
  useCases.rename.mockResolvedValue({ id: "acme", displayName: "Renamed" });
});

describe("registering and deleting", () => {
  it("refuses a workspace admin, however senior in their own workspace", async () => {
    gates.workspaceAdminOf.add("acme");
    expect((await createOrganization(body({ id: "theirs" }, "POST"))).status).toBe(403);
    expect(
      (await deleteOrganization(new Request("https://x/y", { method: "DELETE" }), ctx("acme")))
        .status,
    ).toBe(403);
    expect(useCases.create).not.toHaveBeenCalled();
    expect(useCases.remove).not.toHaveBeenCalled();
  });

  it("admits a deployment operator", async () => {
    gates.deployment = true;
    expect((await createOrganization(body({ id: "new" }, "POST"))).status).toBe(201);
    expect(useCases.create).toHaveBeenCalledWith(
      { id: "new", displayName: "" },
      "her@example.com",
    );
  });

  it("says what a delete deliberately left behind", async () => {
    gates.deployment = true;
    const response = await deleteOrganization(
      new Request("https://x/y", { method: "DELETE" }),
      ctx("acme"),
    );
    expect(((await response.json()) as { note: string }).note).toContain("T#acme#");
  });
});

describe("members", () => {
  it("lets this workspace's admin manage it", async () => {
    gates.workspaceAdminOf.add("acme");
    expect((await listMembers(new Request("https://x/y"), ctx("acme"))).status).toBe(200);
    expect(
      (await setMember(body({ email: "new@x.com", role: "editor" }), ctx("acme"))).status,
    ).toBe(200);
  });

  it("refuses them another workspace's", async () => {
    gates.workspaceAdminOf.add("acme");
    expect((await listMembers(new Request("https://x/y"), ctx("globex"))).status).toBe(403);
    expect(
      (await setMember(body({ email: "new@x.com", role: "admin" }), ctx("globex"))).status,
    ).toBe(403);
    expect(useCases.setMember).not.toHaveBeenCalled();
  });

  it("lets a deployment operator reach a workspace they are not in", async () => {
    // Otherwise a workspace whose last admin left is unreachable by anyone.
    gates.deployment = true;
    expect((await listMembers(new Request("https://x/y"), ctx("globex"))).status).toBe(200);
  });

  it("400s an unknown role rather than storing it", async () => {
    gates.workspaceAdminOf.add("acme");
    expect((await setMember(body({ email: "a@x.com", role: "owner" }), ctx("acme"))).status).toBe(
      400,
    );
    expect(useCases.setMember).not.toHaveBeenCalled();
  });
});

describe("the workspace list", () => {
  it("shows an ordinary member only the workspace they are in", async () => {
    // Not secret, but not a directory of other customers either.
    const body = (await (await listOrganizations()).json()) as {
      organizations: { id: string }[];
    };
    expect(body.organizations.map((o) => o.id)).toEqual(["acme"]);
  });

  it("shows a deployment operator every one", async () => {
    gates.deployment = true;
    const body = (await (await listOrganizations()).json()) as {
      organizations: { id: string }[];
    };
    expect(body.organizations.map((o) => o.id)).toEqual(["acme", "globex"]);
  });
});

describe("renaming", () => {
  it("is the workspace's own to do", async () => {
    gates.workspaceAdminOf.add("acme");
    expect((await renameOrganization(body({ displayName: "Renamed" }, "PATCH"), ctx("acme"))).status).toBe(
      200,
    );
    expect(useCases.rename).toHaveBeenCalledWith("acme", "Renamed");
  });
});
