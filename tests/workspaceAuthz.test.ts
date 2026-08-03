/**
 * The workspace boundary, at the two places it is decided.
 *
 * Isolation is *structural*: `withAuth` enters the caller's tenant before the
 * handler runs, and every key builder takes a tenant, so a route cannot address
 * another workspace's rows by forgetting a check. These cases pin that — a
 * handler reading through the real repository finds nothing when the caller
 * belongs elsewhere — and pin the role matrix, which is the part a key cannot
 * answer.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Membership, OrganizationRole } from "@/domain/organization/membership";

const { authMock, memberships, stored } = vi.hoisted(() => ({
  authMock: { getSession: vi.fn() },
  memberships: { rows: [] as Membership[] },
  stored: { items: new Map<string, Record<string, unknown>>() },
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: authMock.getSession } } }));

// A tiny in-memory table: the point is which *keys* a handler reaches, so the
// store is keyed by the real PK/SK the repositories build.
vi.mock("@/infrastructure/db/client", () => ({
  getTableName: () => "test-table",
  getDocumentClient: () => ({
    async send(command: { constructor: { name: string }; input: Record<string, never> }) {
      const input = command.input as Record<string, never> & {
        Key?: { PK: string; SK: string };
        Item?: Record<string, unknown> & { PK: string; SK: string };
        ExpressionAttributeValues?: Record<string, string>;
        IndexName?: string;
      };
      switch (command.constructor.name) {
        case "GetCommand": {
          const item = stored.items.get(`${input.Key?.PK}|${input.Key?.SK}`);
          return item ? { Item: item } : {};
        }
        case "PutCommand": {
          stored.items.set(`${input.Item?.PK}|${input.Item?.SK}`, input.Item!);
          return {};
        }
        case "QueryCommand": {
          const pk = input.ExpressionAttributeValues?.[":pk"];
          const key = input.IndexName ? "GSI1PK" : "PK";
          return {
            Items: [...stored.items.values()].filter((item) => item[key] === pk),
          };
        }
        default:
          return {};
      }
    },
  }),
}));

// Membership resolution is the real one, reading the fake table above.
vi.mock("@/infrastructure/db/repositories/membershipRepository", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/infrastructure/db/repositories/membershipRepository")
    >();
  return {
    membershipRepository: {
      ...actual.membershipRepository,
      listByUser: async (email: string) =>
        memberships.rows.filter((row) => row.userEmail === email),
      get: async (organizationId: string, email: string) =>
        memberships.rows.find(
          (row) => row.organizationId === organizationId && row.userEmail === email,
        ) ?? null,
    },
  };
});

const { withAuth, withAdminAuth, withAuthorAuth, withDeploymentAdminAuth } = await import(
  "@/lib/session"
);
const { invalidateWorkspaceCache, machineTenant } = await import("@/lib/workspace");
const { projectRepository } = await import(
  "@/infrastructure/db/repositories/projectRepository"
);
const { organizationRepository } = await import(
  "@/infrastructure/db/repositories/organizationRepository"
);
const { withTenant } = await import("@/shared/tenantContext");

function signedInAs(email: string) {
  authMock.getSession.mockResolvedValue({
    user: { id: "u", email, name: "U", image: null },
  });
}

function member(email: string, organizationId: string, role: OrganizationRole): Membership {
  return {
    organizationId,
    userEmail: email,
    role,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

/** A handler that reports what the caller can actually see. */
const readProject = withAuth(async () =>
  Response.json({ project: await projectRepository.get("shared") }),
);

beforeEach(async () => {
  vi.clearAllMocks();
  memberships.rows = [];
  stored.items.clear();
  invalidateWorkspaceCache();
  delete process.env.ADMIN_EMAILS;
  // The same project name in two workspaces, which is the case the key scheme
  // exists to keep apart.
  for (const tenant of ["acme", "globex"]) {
    await withTenant(tenant, () =>
      projectRepository.create({
        name: "shared",
        displayName: tenant,
        description: "",
        projectType: "llm",
        ownerEmail: `owner@${tenant}.com`,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    );
  }
});

describe("workspace isolation", () => {
  it("shows a member their own workspace's project", async () => {
    memberships.rows = [member("a@x.com", "acme", "viewer")];
    signedInAs("a@x.com");
    const body = (await (await readProject()).json()) as { project: { displayName: string } };
    expect(body.project.displayName).toBe("acme");
  });

  it("shows the other workspace's member a different project of the same name", async () => {
    memberships.rows = [member("g@x.com", "globex", "viewer")];
    signedInAs("g@x.com");
    const body = (await (await readProject()).json()) as { project: { displayName: string } };
    expect(body.project.displayName).toBe("globex");
  });

  it("finds the membership however the provider spelled the address", async () => {
    // Memberships are stored lowercased, so an identity provider returning
    // `A@X.com` used to miss the row — and the miss did not look like one: it
    // took the no-membership arm, which drops a workspace member into the
    // shared default catalog under the pre-tenant `ADMIN_EMAILS` rules.
    memberships.rows = [member("a@x.com", "acme", "viewer")];
    signedInAs("A@X.com");
    const body = (await (await readProject()).json()) as { project: { displayName: string } };
    expect(body.project.displayName).toBe("acme");
  });

  it("shows a caller in neither workspace nothing at all", async () => {
    // Not a 403 to be checked and forgotten: the row is not addressable from
    // the default scope, so the read simply finds nothing.
    signedInAs("outsider@x.com");
    const body = (await (await readProject()).json()) as { project: unknown };
    expect(body.project).toBeNull();
  });
});

describe("role matrix", () => {
  const ok = async () => Response.json({ ok: true });
  const status = async (
    wrap: (h: typeof ok) => (...args: never[]) => Promise<Response>,
    role?: OrganizationRole,
  ) => {
    memberships.rows = role ? [member("u@x.com", "acme", role)] : [];
    // The resolution is cached per email; these cases give one email several
    // roles in a row, which no real deployment does within a TTL.
    invalidateWorkspaceCache();
    signedInAs("u@x.com");
    return (await wrap(ok)()).status;
  };

  it("lets every role read and run — the catalog stays shared inside a workspace", async () => {
    for (const role of ["viewer", "editor", "admin"] as const) {
      expect(await status(withAuth, role)).toBe(200);
    }
  });

  it("lets an editor and an admin author, but not a viewer", async () => {
    expect(await status(withAuthorAuth, "viewer")).toBe(403);
    expect(await status(withAuthorAuth, "editor")).toBe(200);
    expect(await status(withAuthorAuth, "admin")).toBe(200);
  });

  it("reserves shared-registry mutation for an admin", async () => {
    expect(await status(withAdminAuth, "viewer")).toBe(403);
    expect(await status(withAdminAuth, "editor")).toBe(403);
    expect(await status(withAdminAuth, "admin")).toBe(200);
  });

  it("does not let an empty ADMIN_EMAILS make a workspace member an admin", async () => {
    // Outside a workspace an empty list means "no restriction". Inside one the
    // members are named, so "nobody was named" cannot mean "everybody" — that
    // fail-open is exactly what a tenant boundary must not inherit.
    process.env.ADMIN_EMAILS = "";
    expect(await status(withAdminAuth, "viewer")).toBe(403);
  });

  it("keeps the default tenant's rules unchanged for a caller with no membership", async () => {
    process.env.ADMIN_EMAILS = "";
    expect(await status(withAdminAuth, undefined)).toBe(200);
    process.env.ADMIN_EMAILS = "someone-else@x.com";
    expect(await status(withAdminAuth, undefined)).toBe(403);
  });
});

describe("the deployment gate", () => {
  const ok = async () => Response.json({ ok: true });
  const status = async (role?: OrganizationRole) => {
    memberships.rows = role ? [member("u@x.com", "acme", role)] : [];
    invalidateWorkspaceCache();
    signedInAs("u@x.com");
    return (await withDeploymentAdminAuth(ok)()).status;
  };

  it("refuses a workspace admin what the whole deployment shares", async () => {
    // The hole this closes: `isAdmin` says yes to a workspace admin, and the
    // app settings row, the A2A key and the managed MCP containers are not
    // their workspace's — they are every workspace's.
    process.env.ADMIN_EMAILS = "operator@x.com";
    expect(await status("admin")).toBe(403);
  });

  it("admits a named operator wherever they happen to be a member", async () => {
    // ADMIN_EMAILS *is* the list of deployment operators; joining a workspace
    // is not a reason to stop being one.
    process.env.ADMIN_EMAILS = "u@x.com";
    expect(await status("viewer")).toBe(200);
  });

  it("keeps the unset-list rule, but only where there are no workspaces", async () => {
    process.env.ADMIN_EMAILS = "";
    expect(await status(undefined)).toBe(200);
    // Inside a workspace an unset list must not promote every member; that is
    // the same fail-open the role matrix refuses above.
    expect(await status("admin")).toBe(403);
  });

  it("withdraws the unset-list rule once the deployment has a workspace", async () => {
    // The half the caller's own resolution cannot answer: someone with no
    // membership resolves to the default tenant however many workspaces exist,
    // so reading only that would make every such person an operator on a
    // multi-workspace deployment whose admin list happens to be empty.
    process.env.ADMIN_EMAILS = "";
    expect(await status(undefined)).toBe(200);
    await organizationRepository.create({
      id: "acme",
      displayName: "Acme",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    invalidateWorkspaceCache();
    expect(await status(undefined)).toBe(403);
  });

  it("refuses while the workspace registry is unreadable, rather than widening", async () => {
    process.env.ADMIN_EMAILS = "";
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const list = vi.spyOn(organizationRepository, "list").mockRejectedValue(new Error("throttled"));
    invalidateWorkspaceCache();
    expect(await status(undefined)).toBe(403);
    list.mockRestore();
    error.mockRestore();
  });

  it("does not re-ask the index that is failing on every request", async () => {
    // This question is asked on every request that reaches a deployment-admin
    // gate. Leaving the fail-closed answer uncached turns a throttling index
    // into one queried once per request — each attempt failing, each logging —
    // which is a storm against the thing already in trouble. The answer is only
    // unsafe to widen; reusing it for the TTL narrows.
    process.env.ADMIN_EMAILS = "";
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const list = vi.spyOn(organizationRepository, "list").mockRejectedValue(new Error("throttled"));
    // Deliberately not through `status`, which clears the cache each call.
    memberships.rows = [];
    invalidateWorkspaceCache();
    signedInAs("u@x.com");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await withDeploymentAdminAuth(ok)()).status).toBe(403);
    }
    expect(list).toHaveBeenCalledTimes(1);
    list.mockRestore();
    error.mockRestore();
  });
});

describe("an unreadable membership store", () => {
  it("refuses the request instead of falling back to the default workspace", async () => {
    // The fallback reads as safe and is not: on a deployment that migrated some
    // users and left the original catalog in the default scope, it drops a
    // workspace member into that catalog with no role at all.
    const listByUser = vi.spyOn(
      (await import("@/infrastructure/db/repositories/membershipRepository"))
        .membershipRepository,
      "listByUser",
    );
    listByUser.mockRejectedValueOnce(new Error("throttled"));
    invalidateWorkspaceCache();
    signedInAs("a@x.com");
    expect((await readProject()).status).toBe(503);
    listByUser.mockRestore();
  });
});

describe("the machine tenant hint", () => {
  const withHeader = (value: string) =>
    machineTenant(new Request("https://studio.example.com/api/a2a/bot", { headers: { "x-tenant": value } }));

  it("takes a slug, and the default tenant's own name", () => {
    expect(withHeader("acme")).toBe("acme");
    expect(withHeader("default")).toBe("default");
  });

  it("is the default tenant when nothing names one", () => {
    expect(machineTenant(new Request("https://studio.example.com/api/a2a/bot"))).toBe("default");
  });

  it("refuses anything that is not a tenant name", () => {
    // Silently scoping to `T#Acme #` would find no credential and answer 401 —
    // sending the caller to rotate a key that was never the problem.
    expect(withHeader("Acme")).toBeNull();
    expect(withHeader("a#b")).toBeNull();
    expect(
      machineTenant(new Request("https://studio.example.com/api/a2a/bot?tenant=NOPE")),
    ).toBeNull();
  });

  it("prefers the header, and falls back to the query for callers that cannot set one", () => {
    const request = new Request("https://studio.example.com/api/a2a/bot?tenant=globex", {
      headers: { "x-tenant": "acme" },
    });
    expect(machineTenant(request)).toBe("acme");
    expect(
      machineTenant(new Request("https://studio.example.com/api/a2a/bot?tenant=globex")),
    ).toBe("globex");
  });
});
