/**
 * What a turned-away visitor is told. The rule under test is not which sentence
 * appears but that the sentence is *chosen here* — the `error` parameter is
 * server text arriving through the address bar, and echoing it is what put this
 * deployment's allowed domains in front of the person who failed to sign in.
 */
import { describe, expect, it } from "vitest";
import { EMAIL_DOMAIN_NOT_ALLOWED, signInErrorMessage } from "@/shared/signInError";

describe("signInErrorMessage", () => {
  it("has nothing to say without an error", () => {
    expect(signInErrorMessage(undefined)).toBeUndefined();
    expect(signInErrorMessage("")).toBeUndefined();
  });

  it("explains a domain refusal without naming the domains", () => {
    const message = signInErrorMessage(EMAIL_DOMAIN_NOT_ALLOWED);
    expect(message).toContain("isn't allowed");
    expect(message).toContain("administrator");
  });

  it("survives Better Auth's underscore mangling", () => {
    // The code crosses the wire as the thrown error's message, which the OAuth
    // callback rewrites with `split(" ").join("_")`. A code with a space in it
    // would arrive as something this mapping no longer recognises.
    expect(EMAIL_DOMAIN_NOT_ALLOWED).not.toContain(" ");
    expect(EMAIL_DOMAIN_NOT_ALLOWED.split(" ").join("_")).toBe(EMAIL_DOMAIN_NOT_ALLOWED);
  });

  it("folds a code it does not know into one generic line", () => {
    expect(signInErrorMessage("access_denied")).toBe(signInErrorMessage("no_code"));
    expect(signInErrorMessage("access_denied")).toContain("Try again");
  });

  it("never echoes what the server sent", () => {
    // The shape a deployment redirected before this mapping existed still
    // produces: a whole sentence, naming the domains it allows.
    const leaky = "Sign-in_is_restricted_to:_nalbam.com";
    const message = signInErrorMessage(leaky);
    expect(message).not.toContain("nalbam.com");
    expect(message).not.toContain("restricted");
    expect(message).toBe(signInErrorMessage("anything-else"));
  });
});
