import { describe, expect, it } from "vitest";
import { authHeaders, type Channel } from "../scripts/check-models";

const channel = (apiKey: string): Channel => ({
  label: "reranker",
  baseUrl: "http://reranker.internal/v1",
  apiKey,
  provider: "selfhosted",
  keepModelPrefix: false,
  auth: "bearer",
});

describe("check-models channel authentication", () => {
  it("omits authorization for an endpoint configured without a key", () => {
    expect(authHeaders(channel(""))).toEqual({});
  });

  it("uses bearer authentication when the channel has a key", () => {
    expect(authHeaders(channel("secret"))).toEqual({ Authorization: "Bearer secret" });
  });
});
