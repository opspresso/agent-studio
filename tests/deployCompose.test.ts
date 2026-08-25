import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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

describe("deployment compose health checks", () => {
  it.each(composeFiles)("probes the Brave listener without spending API quota in $target", ({ text }) => {
    const service = serviceBlock(text, "mcp-brave-search");
    const probe = /^\s+test:.*$/m.exec(service)?.[0] ?? "";
    expect(service).toContain("healthcheck:");
    expect(probe).toContain("require('node:net').connect(80,'127.0.0.1')");
    expect(probe).not.toMatch(/curl|wget|brave\.com|tools\/call/);
  });
});
