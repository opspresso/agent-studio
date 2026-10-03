import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodingGitHub } from "@/infrastructure/github/codingForge";
import { CodingMutationRejectedError } from "@/domain/coding/types";

const now = new Date("2026-09-15T08:00:00Z");
const config = { apiUrl: "http://localhost:9009/api/v3", webUrl: "http://localhost:9009", internalHosts: ["localhost"] };
const input = { repository: "company/new-game", description: "A new game", private: true };
let requests: { path: string; method: string; body: Record<string, unknown>; authorization: string | null }[];
let createStatus: number;
let identityStatus: number;
let userLogin: string;
let resultPatch: Record<string, unknown>;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  requests = []; createStatus = 201; identityStatus = 200; userLogin = "company"; resultPatch = {};
  vi.stubGlobal("fetch", vi.fn(async (raw: URL, init: RequestInit) => {
    const path = new URL(String(raw)).pathname;
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : {};
    requests.push({ path, method, body, authorization: new Headers(init.headers).get("authorization") });
    if (path.endsWith("/user")) return Response.json({ login: userLogin }, { status: identityStatus });
    if (path.endsWith("/orgs/company")) return Response.json({ login: "company" });
    if (method === "POST" && path.endsWith("/repos")) return Response.json({ id: 42, full_name: `company/${body.name}`, html_url: `http://localhost:9009/company/${body.name}`,
      default_branch: "main", private: body.private, ...resultPatch }, { status: createStatus });
    if (path.includes("/orgs/")) return new Response("not an organization", { status: 404 });
    throw new Error("Unexpected GitHub call");
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("GitHub repository creation", () => {
  it("uses the authenticated account, initializes the repository, and returns only verified metadata", async () => {
    const forge = createCodingGitHub({ ...config, getToken: async () => "account-token" }).forge;
    expect(await forge.createRepository!(input)).toEqual({ repository: input.repository, repositoryId: 42,
      url: `http://localhost:9009/${input.repository}`, baseBranch: "main", private: true });
    expect(requests.map(request => request.path)).toEqual(["/api/v3/user", "/api/v3/user/repos"]);
    expect(requests[1]!.body).toEqual({ name: "new-game", description: "A new game", private: true, auto_init: true });
    expect(requests.every(request => request.authorization === "Bearer account-token")).toBe(true);
  });

  it("verifies an organization before creating a repository with the caller's grant", async () => {
    userLogin = "operator";
    const forge = createCodingGitHub({ ...config, getToken: async () => "account-token" }).forge;
    await forge.createRepository!(input);
    expect(requests.map(request => request.path)).toEqual(["/api/v3/user", "/api/v3/orgs/company", "/api/v3/orgs/company/repos"]);
    expect(requests.every(request => request.authorization === "Bearer account-token")).toBe(true);
  });

  it("does not create a repository after the caller's grant is revoked", async () => {
    const forge = createCodingGitHub({ ...config, getToken: async () => { throw new Error("grant revoked"); } }).forge;
    await expect(forge.createRepository!(input)).rejects.toBeInstanceOf(CodingMutationRejectedError);
    expect(requests).toEqual([]);
  });

  it("treats identity and owner failures as pre-creation refusals", async () => {
    const forge = createCodingGitHub({ ...config, getToken: async () => "account-token" }).forge;
    await expect(forge.createRepository!({ ...input, repository: "other-user/game" })).rejects.toBeInstanceOf(CodingMutationRejectedError);
    identityStatus = 401;
    await expect(forge.createRepository!(input)).rejects.toBeInstanceOf(CodingMutationRejectedError);
    expect(requests.every(request => request.method === "GET")).toBe(true);
  });

  it.each([200, 202, 503])("requires an actual 201 creation response, not HTTP %s", async status => {
    createStatus = status;
    const forge = createCodingGitHub({ ...config, getToken: async () => "account-token" }).forge;
    const error = await forge.createRepository!(input).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(CodingMutationRejectedError);
  });

  it("distinguishes a definitive already-exists response from an unknown mutation outcome", async () => {
    createStatus = 422;
    await expect(createCodingGitHub({ ...config, getToken: async () => "account-token" }).forge.createRepository!(input)).rejects.toBeInstanceOf(CodingMutationRejectedError);
  });

  it.each([{ full_name: "other/repo" }, { html_url: "https://elsewhere.example/repo" }, { private: false }, { default_branch: "" }, { id: -1 }])("rejects mismatched creation metadata %j", async patch => {
    resultPatch = patch;
    await expect(createCodingGitHub({ ...config, getToken: async () => "account-token" }).forge.createRepository!(input)).rejects.toThrow();
  });
});
