import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { test, expect } from "@playwright/test";

let server: Server;
let base: string;

test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["browser-tests/fixtures/trace-detail.tsx"], bundle: true, write: false,
    outdir: "/tmp/agent-studio-trace-detail-fixture", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
    plugins: [{ name: "navigation-stub", setup(build) {
      build.onResolve({ filter: /^next\/(navigation|link)$/ }, args => ({ path: args.path, namespace: "navigation-stub" }));
      build.onLoad({ filter: /.*/, namespace: "navigation-stub" }, args => ({
        contents: args.path === "next/navigation"
          ? 'export const useParams = () => ({ name: "agent", traceId: window.__traceDetailId });'
          : 'import React from "react"; export default function Link(props) { return React.createElement("a", { href: props.href }, props.children); }',
        loader: "js", resolveDir: process.cwd(),
      }));
    } }],
  });
  server = createServer((request, response) => {
    const file = bundle.outputFiles.find(file => request.url === `/${file.path.split("/").at(-1)}`);
    response.setHeader("Content-Type", `${file ? file.path.endsWith(".css") ? "text/css" : "text/javascript" : "text/html"}; charset=utf-8`);
    response.end(file?.contents ?? '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/trace-detail.css"><div id="root"></div><script src="/trace-detail.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

test("clears a failed Trace read when navigating to another Trace", async ({ page }) => {
  await page.route("**/api/projects/agent/traces/**", route => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    return id === "missing"
      ? route.fulfill({ status: 404, json: { error: "Trace unavailable" } })
      : route.fulfill({ json: { traceId: "present", projectName: "agent", status: "completed",
        createdAt: "2026-09-24T00:00:00Z", startedAt: "2026-09-24T00:00:00Z",
        durationMs: 10, spans: [] } });
  });
  await page.goto(base);
  await expect(page.getByRole("alert")).toContainText("Trace unavailable");
  await page.getByRole("button", { name: "Switch trace" }).click();
  await expect(page.getByRole("heading", { name: "Trace present" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
