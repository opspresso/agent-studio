import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  resolveProjectTeamsRuntime,
  resolveTeamsEventBinding,
  testProjectTeams,
  updateProjectTeams,
} from "@/application/teams/projectTeams";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { ConflictError, ForbiddenError, ValidationError } from "@/application/errors";
import type { Project } from "@/domain/project/types";
import type { ProjectRepository } from "@/domain/project/repository";

const OWNER = "t@example.com";
const OTHER = "intruder@example.com";
const APP = "11111111-2222-3333-4444-555555555555";

beforeAll(() => {
  process.env.AES_ENCRYPTION_KEY ??= Buffer.alloc(32, 5).toString("base64");
});

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    name: "bot-proj",
    displayName: "Bot Project",
    description: "",
    ownerEmail: OWNER,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function fakeRepo(initial: Project): { repo: ProjectRepository; current: () => Project } {
  let stored = initial;
  const repo = {
    async get(name: string) {
      return name === stored.name ? stored : null;
    },
    async list() {
      return [stored];
    },
    async create(p: Project) {
      stored = p;
    },
    async update(p: Project) {
      stored = p;
    },
    async publish(p: Project) {
      stored = p;
    },
    async delete() {},
    async getApiToken() {
      return null;
    },
    async setApiToken() {},
    async deleteApiToken() {},
  } as unknown as ProjectRepository;
  return { repo, current: () => stored };
}

const update = (repo: ProjectRepository, input: Parameters<typeof updateProjectTeams>[2], email = OWNER) =>
  updateProjectTeams(repo, "bot-proj", input, email, secretCipher);

describe("updateProjectTeams", () => {
  it("stores the App ID in the clear, encrypts the secret and masks it back", async () => {
    const { repo, current } = fakeRepo(makeProject());
    const { view } = await update(repo, { appId: APP, appPassword: "s3cret-value", enabled: true });
    expect(view).toMatchObject({ enabled: true, configured: true, appId: APP, messagingPath: "/api/teams/messages/bot-proj" });
    expect(view.appPassword).not.toContain("s3cret");
    expect(current().teams?.appPassword.startsWith("enc:v2:")).toBe(true);
  });

  it("keeps the stored secret when the input is masked or empty", async () => {
    const { repo, current } = fakeRepo(makeProject());
    await update(repo, { appId: APP, appPassword: "first" });
    const first = current().teams?.appPassword;
    await update(repo, { appPassword: secretCipher.mask(first ?? ""), enabled: true });
    await update(repo, { appPassword: "" });
    expect(current().teams?.appPassword).toBe(first);
    expect(current().teams?.enabled).toBe(true);
  });

  it("refuses a malformed App ID or tenant, enabling without credentials, a non-owner", async () => {
    const { repo } = fakeRepo(makeProject());
    await expect(update(repo, { appId: "not-a-guid", appPassword: "x" })).rejects.toThrow(ValidationError);
    await expect(update(repo, { appId: APP, appPassword: "x", tenantId: "nope" })).rejects.toThrow(ValidationError);
    await expect(update(repo, { enabled: true })).rejects.toThrow(ValidationError);
    await expect(update(repo, { appId: APP, appPassword: "x" }, OTHER)).rejects.toThrow(ForbiddenError);
  });

  it("maps a stale project snapshot to ConflictError", async () => {
    const { repo } = fakeRepo(makeProject());
    repo.update = async () => {
      throw Object.assign(new Error("conditional check failed"), {
        name: "ConditionalWriteFailed",
      });
    };

    await expect(update(repo, { appId: APP, appPassword: "x" })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });
});

describe("runtime, binding and test", () => {
  it("decrypts credentials only for an enabled bot, tenant included", async () => {
    const { repo, current } = fakeRepo(makeProject());
    await update(repo, { appId: APP, appPassword: "pw", tenantId: APP, enabled: true });
    expect(resolveProjectTeamsRuntime(secretCipher, current())).toEqual({ appId: APP, appPassword: "pw", tenantId: APP });
    expect(await resolveTeamsEventBinding(repo, "bot-proj", secretCipher)).toEqual({
      projectName: "bot-proj",
      credentials: { appId: APP, appPassword: "pw", tenantId: APP },
    });
    await update(repo, { enabled: false });
    expect(resolveProjectTeamsRuntime(secretCipher, current())).toBeNull();
    expect(await resolveTeamsEventBinding(repo, "bot-proj", secretCipher)).toBeNull();
  });

  it("refuses a client secret moved under another project name", async () => {
    const { repo, current } = fakeRepo(makeProject());
    await update(repo, { appId: APP, appPassword: "pw", enabled: true });

    expect(() =>
      resolveProjectTeamsRuntime(secretCipher, { ...current(), name: "other" }),
    ).toThrow();
  });

  it("proves the registration by acquiring a token", async () => {
    const { repo } = fakeRepo(makeProject());
    await update(repo, { appId: APP, appPassword: "pw", enabled: true });
    const authenticate = vi.fn(async () => ({ expiresInSeconds: 3599 }));
    expect(await testProjectTeams(repo, "bot-proj", OWNER, secretCipher, authenticate)).toEqual({
      ok: true,
      appId: APP,
      expiresInSeconds: 3599,
    });
    expect(authenticate).toHaveBeenCalledWith({ appId: APP, appPassword: "pw" });
    const bare = fakeRepo(makeProject());
    expect(await testProjectTeams(bare.repo, "bot-proj", OWNER, secretCipher, authenticate)).toEqual({ ok: false });
  });
});
