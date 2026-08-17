import { afterEach, describe, expect, it, vi } from "vitest";
import { apiError } from "@/app/api/_lib/http";
import {
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  UpstreamError,
  ValidationError,
} from "@/application/errors";

/**
 * Typing an error moved it out of the log as a side effect: the branch that
 * answers with the error's own message returned before reaching `log.error`. The
 * caller was told more and the server recorded less, which is the wrong half to
 * lose — a report arriving an hour later has only the log to work from.
 */
describe("apiError logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function captured(error: unknown): { warn: number; error: number; status: number } {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const status = apiError(error).status;
    return { warn: warn.mock.calls.length, error: err.mock.calls.length, status };
  }

  it("records a typed 5xx, which used to answer in full and leave no trace", () => {
    const result = captured(new UpstreamError("404 The requested resource was not found."));

    expect(result.status).toBe(502);
    expect(result.warn).toBe(1);
    // Not `error`: another system refused. What this app could not account for
    // at all keeps that level to itself.
    expect(result.error).toBe(0);
  });

  it("names the failure in the line, so the log is worth grepping", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    apiError(new UpstreamError("Image generation failed for xai/grok: 404 not found"));

    const line = warn.mock.calls[0]?.map(String).join(" ") ?? "";
    expect(line).toContain("[api]");
    expect(line).toContain("Image generation failed for xai/grok");
  });

  // The API working as designed. Logging these buries the 5xx under every
  // rejected request, which is why there was no log line here to begin with.
  it.each([
    ["a bad body", new ValidationError("Invalid name"), 400],
    ["a name that is not there", new NotFoundError("no such project"), 404],
    ["a caller without rights", new ForbiddenError("not yours"), 403],
    ["a refusal that says when to retry", new RateLimitedError("over the cap", 42), 429],
  ])("stays quiet on %s", (_label, error, status) => {
    const result = captured(error);

    expect(result.status).toBe(status);
    expect(result.warn).toBe(0);
    expect(result.error).toBe(0);
  });

  it("still reports an untyped throw as a defect, and says nothing about it", async () => {
    const result = captured(new Error("connect ECONNREFUSED 10.0.0.1:5432"));

    expect(result.status).toBe(500);
    expect(result.error).toBe(1);
    expect(result.warn).toBe(0);
  });

  it("gives an untyped throw's message to the log and not to the caller", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const body = (await apiError(new Error("secret-bucket/key does not exist")).json()) as {
      error: string;
    };

    expect(body.error).toBe("Internal server error");
  });

  it("treats a caller who hung up as neither a failure nor a defect", () => {
    // Next aborts `request.signal` with `ResponseAborted` — an Error with no
    // message — the moment the browser leaves, and the run's abort lands in the
    // route's catch as that. Read as an error it was an *unhandled* one: a
    // reload through a slow image generation, filed at `error` level.
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const controller = new AbortController();
    const responseAborted = new Error();
    responseAborted.name = "ResponseAborted";
    controller.abort(responseAborted);
    const request = new Request("https://example.test/api/x", { signal: controller.signal });

    const response = apiError(responseAborted, request);

    expect(response.status).toBe(499);
    expect(warn).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    expect(info.mock.calls[0]?.map(String).join(" ")).toContain("caller left");
  });

  it("maps as before when the caller is still there", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const request = new Request("https://example.test/api/x");

    const response = apiError(new Error("connect ECONNREFUSED"), request);

    expect(response.status).toBe(500);
    expect(err).toHaveBeenCalledTimes(1);
  });
});
