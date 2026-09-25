import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { test, expect } from "@playwright/test";

let server: Server;
let base: string;

test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["browser-tests/fixtures/agent-usage.tsx"], bundle: true, write: false,
    outdir: "/tmp/agent-studio-agent-usage-fixture", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
    plugins: [{ name: "next-stub", setup(build) {
      build.onResolve({ filter: /^next\/(navigation|dynamic)$/ }, args => ({ path: args.path, namespace: "next-stub" }));
      build.onLoad({ filter: /.*/, namespace: "next-stub" }, args => ({
        contents: args.path === "next/navigation"
          ? 'export const useParams = () => ({ name: "agent" });'
          : 'import React from "react"; export default function dynamic() { return () => React.createElement("div"); }',
        loader: "js", resolveDir: process.cwd(),
      }));
    } }],
  });
  server = createServer((request, response) => {
    const file = bundle.outputFiles.find(file => request.url === `/${file.path.split("/").at(-1)}`);
    response.setHeader("Content-Type", `${file ? file.path.endsWith(".css") ? "text/css" : "text/javascript" : "text/html"}; charset=utf-8`);
    response.end(file?.contents ?? '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/agent-usage.css"><div id="root"></div><script src="/agent-usage.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

test("reports an owner lookup failure and loads caller usage after retry", async ({ page }) => {
  let agentReads = 0;
  let actorReads = 0;
  await page.route("**/api/agents/agent", route => {
    agentReads += 1;
    return agentReads === 1
      ? route.fulfill({ status: 503, json: { error: "Agent store unavailable" } })
      : route.fulfill({ json: { ownerEmail: "owner@example.test" } });
  });
  await page.route("**/api/usages/summary?**", route => route.fulfill({ json: { items: [{
    agentName: "agent", date: "2026-09-24", calls: { model: 1 }, inputTokens: { model: 1 },
    outputTokens: { model: 1 }, costUsd: { model: 0.01 },
  }] } }));
  await page.route("**/api/agents/agent/usage/actors?**", route => {
    actorReads += 1;
    return route.fulfill({ json: { items: [], totalActors: 0, truncated: false } });
  });
  await page.goto(base);
  await expect(page.getByRole("alert")).toContainText("Agent store unavailable");
  expect(actorReads).toBe(0);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect.poll(() => actorReads).toBe(1);
  expect(agentReads).toBe(2);
});
