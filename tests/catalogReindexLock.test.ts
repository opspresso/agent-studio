import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeStore } from "./fakeStore";

vi.mock("@/infrastructure/db/store", async () => (await import("./fakeStore")).createFakeStore());
const store = (await import("@/infrastructure/db/store")) as unknown as FakeStore;
const { catalogReindexLock } = await import(
  "@/infrastructure/db/repositories/catalogReindexLock"
);

beforeEach(() => {
  store.rows.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("catalogReindexLock", () => {
  it("allows only one live holder and releases only its token", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const token = await catalogReindexLock.acquire(60_000);
    expect(token).toBeTruthy();
    await expect(catalogReindexLock.state()).resolves.toEqual({ generation: 1, active: true });
    await expect(catalogReindexLock.acquire(60_000)).resolves.toBeNull();
    await catalogReindexLock.release("not-the-owner");
    await expect(catalogReindexLock.acquire(60_000)).resolves.toBeNull();
    await catalogReindexLock.release(token!);
    await expect(catalogReindexLock.state()).resolves.toEqual({ generation: 1, active: false });
    await expect(catalogReindexLock.acquire(60_000)).resolves.toBeTruthy();
    await expect(catalogReindexLock.state()).resolves.toEqual({ generation: 2, active: true });
  });

  it("lets a new pass reclaim an expired lease", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    await expect(catalogReindexLock.acquire(60_000)).resolves.toBeTruthy();
    now.mockReturnValue(61_001);
    await expect(catalogReindexLock.acquire(60_000)).resolves.toBeTruthy();
    await expect(catalogReindexLock.state()).resolves.toEqual({ generation: 2, active: true });
  });
});
