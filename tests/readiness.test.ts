import { describe, expect, it } from "vitest";
import { checkReadiness } from "@/application/health/readiness";

const ok = () => Promise.resolve();
const fail = () => Promise.reject(new Error("down"));

describe("checkReadiness", () => {
  it("is ready when the database probe succeeds", async () => {
    expect(await checkReadiness({ checkDb: ok })).toEqual({
      ready: true,
      checks: { db: "ok" },
    });
  });

  it("is unready and pinpoints the DB when the DB probe fails", async () => {
    expect(await checkReadiness({ checkDb: fail })).toEqual({
      ready: false,
      checks: { db: "unreachable" },
    });
  });

  it("reports a synchronous probe failure without exposing its details", async () => {
    const report = await checkReadiness({ checkDb: () => { throw new Error("secret dsn leak"); } });
    expect(report).toEqual({ ready: false, checks: { db: "unreachable" } });
  });

  it("does not surface probe error details", async () => {
    const report = await checkReadiness({
      checkDb: () => Promise.reject(new Error("secret dsn leak")),
    });
    expect(JSON.stringify(report)).not.toContain("secret dsn leak");
  });
});
