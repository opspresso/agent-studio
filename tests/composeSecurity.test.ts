import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const compose = readFileSync(new URL("../compose.yaml", import.meta.url), "utf8");

describe("local compose network exposure", () => {
  it("publishes fixed-credential storage services on loopback only", () => {
    expect(compose).toContain('"127.0.0.1:5432:5432"');
    expect(compose).toContain('"127.0.0.1:9000:9000"');
    expect(compose).toContain('"127.0.0.1:9001:9001"');
    expect(compose).not.toMatch(/^\s*-\s*["']?(?:5432:5432|900[01]:900[01])["']?\s*$/m);
  });
});
