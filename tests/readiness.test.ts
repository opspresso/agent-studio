import { describe, expect, it } from "vitest";
import { checkReadiness } from "@/application/health/readiness";

const ok = () => Promise.resolve();
const fail = () => Promise.reject(new Error("down"));

describe("checkReadiness", () => {
  it("is ready when both probes succeed", async () => {
    expect(await checkReadiness({ checkDb: ok, checkLlm: ok })).toEqual({
      ready: true,
      checks: { db: "ok", llm: "ok" },
    });
  });

  it("is unready and pinpoints the DB when the DB probe fails", async () => {
    expect(await checkReadiness({ checkDb: fail, checkLlm: ok })).toEqual({
      ready: false,
      checks: { db: "unreachable", llm: "ok" },
    });
  });

  it("is unready when the LLM probe fails", async () => {
    const report = await checkReadiness({ checkDb: ok, checkLlm: fail });
    expect(report.ready).toBe(false);
    expect(report.checks.llm).toBe("unreachable");
  });

  it("does not surface probe error details", async () => {
    const report = await checkReadiness({
      checkDb: () => Promise.reject(new Error("secret dsn leak")),
      checkLlm: ok,
    });
    expect(JSON.stringify(report)).not.toContain("secret dsn leak");
  });
});
