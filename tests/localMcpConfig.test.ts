import { describe, expect, it, vi } from "vitest";
import { validateConfig } from "../deploy/local/scripts/check-config.mjs";

describe("resolved local MCP configuration", () => {
  it("requires credentials only for enabled services and never echoes values", () => {
    expect(validateConfig({ services: {} })).toEqual([]);
    const errors = validateConfig({ services: {
      "mcp-grafana": { environment: { GRAFANA_URL: "https://grafana.test", GRAFANA_SERVICE_ACCOUNT_TOKEN: " " } },
    } });
    expect(errors).toEqual(["mcp-grafana: GRAFANA_SERVICE_ACCOUNT_TOKEN is required"]);
    expect(errors.join(" ")).not.toContain("https://grafana.test");
  });

  it("accepts resolved kubeconfig paths containing spaces", () => {
    const fileExists = vi.fn(() => true);
    expect(validateConfig({ services: { "mcp-kubernetes": {
      volumes: [{ type: "bind", target: "/config/kubeconfig", source: "/config files/dev kubeconfig" }],
    } } }, fileExists)).toEqual([]);
    expect(fileExists).toHaveBeenCalledWith("/config files/dev kubeconfig");
  });

  it("rejects missing kubeconfig files and incomplete AWS credentials", () => {
    expect(validateConfig({ services: { "mcp-kubernetes": { volumes: [] } } }, () => false))
      .toEqual(["mcp-kubernetes: KUBECONFIG_PATH must name an existing file"]);
    expect(validateConfig({ services: { "mcp-cloudwatch": { environment: { AWS_ACCESS_KEY_ID: "test" } } } }))
      .toEqual(["mcp-cloudwatch: AWS_SECRET_ACCESS_KEY is required"]);
  });
});
