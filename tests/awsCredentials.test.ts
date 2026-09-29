import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  factory: vi.fn(),
  credentials: vi.fn(async (_options?: { forceRefresh?: boolean }) => ({ accessKeyId: "fixture-id", secretAccessKey: "fixture-secret" })),
}));
vi.mock("@aws-sdk/credential-provider-node", () => ({ defaultProvider: f.factory }));
vi.mock("@/lib/config", () => ({ config: { awsRegion: "ap-northeast-2" } }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  f.factory.mockReturnValue(f.credentials);
});

describe("AWS credential chain binding", () => {
  it("shares one lazy provider with the deployment region for role assumption", async () => {
    const { awsCredentials } = await import("@/infrastructure/llm/awsCredentials");
    expect(f.factory).not.toHaveBeenCalled();
    const provider = awsCredentials();
    expect(awsCredentials()).toBe(provider);
    expect(f.factory).toHaveBeenCalledTimes(1);
    expect(await f.factory.mock.calls[0]![0].parentClientConfig.region()).toBe("ap-northeast-2");
    expect(f.credentials).not.toHaveBeenCalled();
    expect(await provider()).toEqual({ accessKeyId: "fixture-id", secretAccessKey: "fixture-secret" });
  });

  it("lets the SDK provider refresh credentials instead of caching their values", async () => {
    const { awsCredentials } = await import("@/infrastructure/llm/awsCredentials");
    const renewed = { accessKeyId: "renewed-fixture-id", secretAccessKey: "renewed-fixture-secret" };
    f.credentials.mockResolvedValueOnce({ accessKeyId: "fixture-id", secretAccessKey: "fixture-secret" }).mockResolvedValueOnce(renewed);
    await awsCredentials()();
    expect(await awsCredentials()({ forceRefresh: true })).toEqual(renewed);
    expect(f.credentials).toHaveBeenLastCalledWith({ forceRefresh: true });
    expect(f.factory).toHaveBeenCalledTimes(1);
  });

  it("propagates missing credentials", async () => {
    const { awsCredentials } = await import("@/infrastructure/llm/awsCredentials");
    f.credentials.mockRejectedValueOnce(new Error("Credentials unavailable"));
    await expect(awsCredentials()()).rejects.toThrow("Credentials unavailable");
    expect(f.credentials).toHaveBeenCalledTimes(1);
  });
});
