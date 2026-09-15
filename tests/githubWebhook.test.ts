import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyGitHubSignature } from "@/shared/githubWebhook";

describe("GitHub webhook signatures", () => {
  it("matches GitHub's published HMAC-SHA256 test vector", () => {
    expect(verifyGitHubSignature("It's a Secret to Everybody", "Hello, World!",
      "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17")).toBe(true);
  });
  it("verifies original UTF-8 bytes and refuses whitespace changes or a different secret", () => {
    const raw = '{ "title": "박쥐 🦇" }\n';
    const signature = `sha256=${createHmac("sha256", "test-secret").update(raw).digest("hex")}`;
    expect(verifyGitHubSignature("test-secret", raw, signature)).toBe(true);
    expect(verifyGitHubSignature("test-secret", JSON.stringify(JSON.parse(raw)), signature)).toBe(false);
    expect(verifyGitHubSignature("another-secret", raw, signature)).toBe(false);
  });
  it.each([null, "", "sha1=" + "a".repeat(40), "sha256=" + "a".repeat(63), "sha256=" + "z".repeat(64)])("refuses missing or malformed signatures", signature => {
    expect(verifyGitHubSignature("test-secret", "body", signature)).toBe(false);
  });
});
