/**
 * The rule the console's detail pages write their loaded state behind. Tested
 * here rather than through a component because the whole rule is the ticket:
 * these tests run in the node environment like every other unit test.
 */
import { describe, expect, it } from "vitest";
import { createLatestOnly } from "@/app/_lib/latestOnly";

describe("createLatestOnly", () => {
  it("lets a lone run write", () => {
    const claim = createLatestOnly();
    expect(claim()()).toBe(true);
  });

  it("retires a run as soon as a later one starts", () => {
    const claim = createLatestOnly();
    const first = claim();
    expect(first()).toBe(true);
    const second = claim();
    // The order the answers arrive in is not the order they were asked in;
    // that is the whole case this exists for.
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it("stays true for the newest run however many were started", () => {
    const claim = createLatestOnly();
    const tickets = [claim(), claim(), claim()];
    expect(tickets.map((isCurrent) => isCurrent())).toEqual([false, false, true]);
  });

  it("keeps two components apart", () => {
    const a = createLatestOnly();
    const b = createLatestOnly();
    const first = a();
    b();
    expect(first()).toBe(true);
  });
});
