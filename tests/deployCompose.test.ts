import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };
const chart = readFileSync(new URL("../deploy/helm/agent-studio/Chart.yaml", import.meta.url), "utf8");

const composeFiles = ["local", "idc"].map((target) => ({
  target,
  text: readFileSync(new URL(`../deploy/${target}/compose.yaml`, import.meta.url), "utf8"),
}));

function serviceBlock(compose: string, name: string): string {
  const marker = `  ${name}:\n`;
  const start = compose.indexOf(marker);
  if (start < 0) {
    return "";
  }
  const rest = compose.slice(start + marker.length);
  const next = /^  [a-z][a-z0-9-]*:/m.exec(rest);
  return marker + rest.slice(0, next?.index ?? rest.length);
}

describe("deployment configuration", () => {
  it.each(composeFiles)("probes the Brave listener without spending API quota in $target", ({ text }) => {
    const service = serviceBlock(text, "mcp-brave-search");
    const probe = /^\s+test:.*$/m.exec(service)?.[0] ?? "";
    expect(service).toContain("healthcheck:");
    expect(probe).toContain("require('node:net').connect(80,'127.0.0.1')");
    expect(probe).not.toMatch(/curl|wget|brave\.com|tools\/call/);
  });

  it.each(composeFiles)("keeps AWS-backed MCP services behind the aws profile in $target", ({ text }) => {
    expect(serviceBlock(text, "mcp-memory")).toContain("profiles: [aws]");
    expect(serviceBlock(text, "mcp-cloudwatch")).toContain("profiles: [aws]");
  });

  it("keeps the Helm default image tag aligned with the application version", () => {
    expect(chart).toContain(`appVersion: "${packageVersion.version}"`);
  });
});
