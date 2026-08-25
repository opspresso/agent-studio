import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "@/lib/config";

/**
 * `MODELS_CATALOG_URL`: the published catalog's address. Unset and `none` are
 * answered as `undefined` so neither wiring site builds a remote source.
 */
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("config.modelsCatalogUrl", () => {
  it("does not read remotely by default and takes an address as given", () => {
    vi.stubEnv("MODELS_CATALOG_URL", "");
    expect(config.modelsCatalogUrl).toBeUndefined();
    vi.stubEnv("MODELS_CATALOG_URL", "https://mirror.internal/models.json");
    expect(config.modelsCatalogUrl).toBe("https://mirror.internal/models.json");
  });

  it("reads none, in any case, as no remote read at all", () => {
    for (const value of ["none", "NONE", "None"]) {
      vi.stubEnv("MODELS_CATALOG_URL", value);
      expect(config.modelsCatalogUrl).toBeUndefined();
    }
  });
});
