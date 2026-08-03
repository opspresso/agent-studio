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

const { withAuth, withAdminAuth, withAuthorAuth } = await import("@/lib/session");
const { projectRepository } = await import(
  "@/infrastructure/db/repositories/projectRepository"
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
