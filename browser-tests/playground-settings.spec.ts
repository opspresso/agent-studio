import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { test, expect } from "@playwright/test";

let server: Server;
let base: string;
let toolRequests: unknown[];
let connectionRequests: string[];
let configurationWrites: Record<string, unknown>[];
let connected: boolean;
const prefix = "/api/agents/fixture-agent";
const serverName = "personal-tools";

test.beforeAll(async () => {
  const bundle = await build({
    entryPoints: ["browser-tests/fixtures/playground-settings.tsx"], bundle: true, write: false,
    outdir: "/tmp/agent-studio-playground-settings-fixture", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
    plugins: [{ name: "next-navigation", setup(build) {
      build.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "next-stub" }));
      build.onLoad({ filter: /.*/, namespace: "next-stub" }, () => ({
        contents: 'export const useParams = () => ({ name: "fixture-agent" }); export const usePathname = () => location.pathname;', loader: "js",
      }));
    } }],
  });
  server = createServer((request, response) => {
    const file = bundle.outputFiles.find(file => request.url === `/${file.path.split("/").at(-1)}`);
    response.setHeader("Content-Type", `${file ? file.path.endsWith(".css") ? "text/css" : "text/javascript" : "text/html"}; charset=utf-8`);
    response.end(file?.contents ?? '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/playground-settings.css"><div id="root"></div><script src="/playground-settings.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
test.beforeEach(async ({ page }) => {
  toolRequests = []; connectionRequests = []; configurationWrites = []; connected = true;
  page.on("pageerror", error => { throw error; });
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === prefix) return route.fulfill({ json: { name: "fixture-agent", ownerEmail: "owner@example.test" } });
    if (path === `${prefix}/configuration`) {
      if (method === "PUT") configurationWrites.push(route.request().postDataJSON());
      return route.fulfill({ json: { updatedAt: "2026-10-02T00:00:00Z", configuration: {
        agentName: "fixture-agent", model: "fixture-model", systemPrompt: "Shared prompt", parameters: { piiFiltering: false },
        mcpList: [{ name: serverName, headers: { "X-Shared": "••••" }, tools: ["lookup"] }], skillList: [], subagentList: [],
        ...configurationWrites.at(-1),
      } } });
    }
    if (path === "/api/models") return route.fulfill({ json: { models: [] } });
    if (["/api/mcps", "/api/skills", "/api/agents"].includes(path)) return route.fulfill({ json: [] });
    if (path === `/api/mcps/${serverName}`) return route.fulfill({ json: {
      name: serverName, url: "https://mcp.example.test", headers: {},
      auth: { resource: "https://mcp.example.test", clientId: "fixture-client" },
    } });
    if (path === `${prefix}/mcp-connections/${serverName}/tools`) {
      toolRequests.push(route.request().postDataJSON());
      return route.fulfill({ json: { tools: [{ name: "lookup", description: "Read personal data" }] } });
    }
    if (path.startsWith(`${prefix}/mcp-connections`)) {
      connectionRequests.push(method);
      if (method === "DELETE") { connected = false; return route.fulfill({ status: 204 }); }
      if (method === "POST") return route.fulfill({ json: { authorizeUrl: "about:blank#fixture-authorization" } });
      return route.fulfill({ json: { connections: connected ? [{ serverName, status: "connected", scopes: [],
        connectedAccount: { label: "my-account" } }] : [] } });
    }
    return route.abort();
  });
});

for (const role of ["member", "admin"]) {
  test(`${role} opens another owner's MCP settings and manages only personal connections`, async ({ page }, testInfo) => {
    await page.goto(`${base}?role=${role}`);
    await expect(page.getByRole("textbox", { name: "System prompt", exact: true })).toBeDisabled();
    const settings = page.getByRole("button", { name: "Settings", exact: true });
    await expect(settings).toBeEnabled();
    await settings.click();
    const dialog = page.getByRole("dialog", { name: "personal-tools settings" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("checkbox", { name: /lookup/ })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "+ Add header override", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Add file mapping", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Refresh tools", exact: true }).click();
    await expect.poll(() => toolRequests.length).toBe(2);
    expect(toolRequests).toEqual([{}, {}]);
    await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Connect", exact: true })).toBeEnabled();
    await expect.poll(() => toolRequests.length).toBe(3);
    const popupPromise = page.waitForEvent("popup");
    await dialog.getByRole("button", { name: "Connect", exact: true }).click();
    const popup = await popupPromise;
    await expect.poll(() => connectionRequests.includes("POST")).toBe(true);
    await popup.close();
    expect(connectionRequests).toContain("DELETE");
    expect(configurationWrites).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`${role}-mcp-settings.png`) });
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "System prompt", exact: true })).toHaveValue("Shared prompt");
  });
}

test("guest can inspect MCP settings without personal connection reads or tool execution", async ({ page }) => {
  await page.goto(`${base}?role=guest`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "+ Add header override", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Add file mapping", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: /^(Connect|Disconnect|Refresh tools|Save)$/ })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  expect(toolRequests).toEqual([]);
  expect(connectionRequests).toEqual([]);
  expect(configurationWrites).toEqual([]);
});

test("owner can edit and save binding tools and probe draft headers", async ({ page }) => {
  await page.goto(`${base}?role=owner`);
  await expect(page.getByRole("textbox", { name: "System prompt", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "+ Add header override", exact: true })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "Add file mapping", exact: true })).toBeEnabled();
  await dialog.getByRole("checkbox", { name: /lookup/ }).uncheck();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => configurationWrites.length).toBe(1);
  expect(configurationWrites[0]?.mcpList).toEqual([{ name: serverName, headers: { "X-Shared": "••••" } }]);
  expect(toolRequests).toEqual([{ headerOverrides: { "X-Shared": "••••" } }]);
});
