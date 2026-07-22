import { afterEach, describe, expect, it } from "vitest";
import { config } from "@/lib/config";

const ORIGINAL = process.env.ADMIN_EMAILS;

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env.ADMIN_EMAILS;
  } else {
    process.env.ADMIN_EMAILS = ORIGINAL;
  }
});

describe("config.adminEmails", () => {
  it("returns an empty list when ADMIN_EMAILS is unset", () => {
    delete process.env.ADMIN_EMAILS;
    expect(config.adminEmails).toEqual([]);
  });

  it("splits, trims, and lowercases comma-separated entries", () => {
    process.env.ADMIN_EMAILS = " Admin@Example.com , ops@example.com ,";
    expect(config.adminEmails).toEqual(["admin@example.com", "ops@example.com"]);
  });
});
