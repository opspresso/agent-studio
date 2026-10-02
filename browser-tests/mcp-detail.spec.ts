import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { test, expect } from "@playwright/test";
import type { McpServerAuth } from "../src/domain/mcp/types";

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

for (const admin of [true, false]) {
  test(`${admin ? "admin configures" : "member cannot configure"} the shared OAuth app in Tools`, async ({ page }) => {
    let auth: McpServerAuth | undefined;
    const writes: Record<string, unknown>[] = [];
    const callback = `${base}/api/mcps/oauth/callback`;
    await page.route("**/api/mcps/**", route => {
      const request = route.request();
      if (new URL(request.url()).pathname.endsWith("/auth")) {
        if (request.method() === "POST") {
          auth = { type: "oauth2", resource: "https://api.githubcopilot.com/mcp/", issuer: "https://github.com/login/oauth",
            authorizationServer: "https://github.com/login/oauth", authorizationEndpoint: "https://github.com/login/oauth/authorize",
            tokenEndpoint: "https://github.com/login/oauth/access_token", tokenEndpointAuthMethod: "client_secret_post",
            discoveredAt: "2026-10-02T00:00:00Z" };
          return route.fulfill({ json: { status: "discovered", auth } });
        }
        if (request.method() === "PUT") {
          const body = request.postDataJSON();
          writes.push(body);
          auth = { ...auth!, clientId: body.clientId, clientSecret: "••••", redirectUri: body.redirectUri };
          return route.fulfill({ json: auth });
        }
        return route.fulfill({ json: { auth, defaultRedirectUri: callback } });
      }
      return route.fulfill({ json: { name: "first", url: "https://api.githubcopilot.com/mcp/", headers: {}, auth } });
    });
    await page.goto(`${base}${admin ? "?admin" : ""}`);
    await expect(page.getByRole("heading", { name: "first", exact: true })).toBeVisible();
    if (!admin) {
      await expect(page.getByRole("button", { name: "Discover", exact: true })).toHaveCount(0);
      await expect(page.getByLabel("Client ID", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Save OAuth client", exact: true })).toHaveCount(0);
      expect(writes).toEqual([]);
      return;
    }
    await page.getByRole("button", { name: "Discover", exact: true }).click();
    await page.getByLabel("Client ID", { exact: true }).fill("shared-github-app");
    await page.getByLabel("Client secret", { exact: true }).fill("synthetic-app-secret");
    await expect(page.getByLabel("Redirect URI", { exact: true })).toHaveValue(callback);
    await page.getByRole("button", { name: "Save OAuth client", exact: true }).click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toEqual({ clientId: "shared-github-app", clientSecret: "synthetic-app-secret", redirectUri: callback });
    await expect(page.getByLabel("Client ID", { exact: true })).toHaveValue("shared-github-app");
    await expect(page.getByLabel(/Client secret/)).not.toHaveValue("synthetic-app-secret");
  });
}

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
