import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { test, expect } from "@playwright/test";

let server: Server;
let base: string;

test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["browser-tests/fixtures/mcp-detail.tsx"], bundle: true, write: false,
    outdir: "/tmp/agent-studio-mcp-detail-fixture", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
    plugins: [{ name: "navigation-stub", setup(build) {
      build.onResolve({ filter: /^next\/(navigation|link)$/ }, args => ({ path: args.path, namespace: "navigation-stub" }));
      build.onLoad({ filter: /.*/, namespace: "navigation-stub" }, args => ({
        contents: args.path === "next/navigation"
          ? "export const useParams = () => ({ name: window.__mcpDetailName }); export const useRouter = () => ({ push() {} });"
          : 'import React from "react"; export default function Link(props) { return React.createElement("a", { href: props.href }, props.children); }',
        loader: "js",
        resolveDir: process.cwd(),
      }));
    } }],
  });
  server = createServer((request, response) => {
    const file = bundle.outputFiles.find(file => request.url === `/${file.path.split("/").at(-1)}`);
    response.setHeader("Content-Type", `${file ? file.path.endsWith(".css") ? "text/css" : "text/javascript" : "text/html"}; charset=utf-8`);
    response.end(file?.contents ?? '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/mcp-detail.css"><div id="root"></div><script src="/mcp-detail.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

test("does not show an earlier server's delayed connection test after navigation", async ({ page }) => {
  const at = "2026-09-24T00:00:00Z";
  const serverRow = (name: string) => ({ name, url: `https://${name}.example.test/mcp`, description: name,
    headers: {}, createdAt: at, updatedAt: at });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const testing = new Promise<void>(resolve => { started = resolve; });
  await page.route("**/api/mcps/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/mcps/first/tools") {
      started();
      await held;
      return route.fulfill({ json: { tools: [{ name: "old_tool", inputSchema: { type: "object" } }] } });
    }
    if (path === "/api/mcps/second/tools") {
      return route.fulfill({ json: { tools: [{ name: "new_tool", inputSchema: { type: "object" } }] } });
    }
    const name = path.split("/").at(-1)!;
    return route.fulfill({ json: serverRow(name) });
  });
  try {
    await page.goto(base);
    await expect(page.getByRole("heading", { name: "first" })).toBeVisible();
    await page.getByRole("button", { name: "Test connection" }).click();
    await testing;
    await page.getByRole("button", { name: "Switch server" }).click();
    await expect(page.getByRole("heading", { name: "second" })).toBeVisible();
    await page.getByRole("button", { name: "Test connection" }).click();
    await expect(page.getByText("new_tool", { exact: true })).toBeVisible();
    release();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("new_tool", { exact: true })).toBeVisible();
    await expect(page.getByText("old_tool", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Test connection" })).toBeEnabled();
  } finally {
    release();
  }
});
