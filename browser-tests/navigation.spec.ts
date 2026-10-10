import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { test, expect } from "@playwright/test";

let server: Server;
let base: string;
const at = "2026-10-09T00:00:00Z";
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["browser-tests/fixtures/navigation.tsx"], bundle: true, write: false,
    outdir: "/tmp/agent-studio-navigation-fixture", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
    plugins: [{ name: "navigation", setup(build) {
      build.onResolve({ filter: /^next\/(navigation|link)$/ }, args => ({ path: args.path, namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path === "next/link"
        ? 'import {createElement} from "react"; export default function Link(props) { return createElement("a", props); }'
        : 'export const useRouter = () => ({ push() {}, replace() {} }); export const useSearchParams = () => new URLSearchParams(location.search);', loader: "js", resolveDir: process.cwd() }));
    } }],
  });
  server = createServer((request, response) => {
    const file = bundle.outputFiles.find(file => request.url === `/${file.path.split("/").at(-1)}`);
    response.setHeader("Content-Type", `${file ? file.path.endsWith(".css") ? "text/css" : "text/javascript" : "text/html"}; charset=utf-8`);
    response.end(file?.contents ?? '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/navigation.css"><div id="root"></div><script src="/navigation.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
test.beforeEach(async ({ page }) => {
  page.on("pageerror", error => { throw error; });
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    const common = { name: "fixture", description: "Resource description", createdAt: at, updatedAt: at };
    const responses: Record<string, unknown> = {
      "/api/agents": [{ ...common, displayName: "Fixture Agent", ownerEmail: "viewer@example.test", configured: true }],
      "/api/skills": [{ ...common, files: 0 }],
      "/api/mcps": [{ ...common, headers: {}, url: "https://mcp.example.test", runtime: "remote" }],
      "/api/plugins": [{ ...common, skills: [], mcpServers: [], syncedAt: at, commitSha: "fixture" }],
      "/api/plugins/sync": { configured: false },
      "/api/members": { members: [{ id: "viewer", name: "Fixture member", email: "viewer@example.test", tier: "admin", joinedAt: at, tierLocked: true }], tiers: ["admin", "member"] },
      "/api/models/registry": { models: [{ id: "fixture/model", provider: "fixture", wireId: "model", displayName: "Fixture model", type: "text", capabilities: {}, contextWindow: 1000, maxTokens: 100 }] },
      "/api/models/favorites": { models: [] },
    };
    return path in responses ? route.fulfill({ json: responses[path] }) : route.abort();
  });
});

for (const width of [390, 1440]) for (const path of ["agents", "skills", "tools", "plugins"]) {
  test(`${path} uses a title link and passive card content at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${base}/${path}`);
    const card = page.locator("main article").first();
    const link = card.getByRole("link", { name: path === "agents" ? "Fixture Agent" : "fixture", exact: true });
    await expect(link).toHaveAttribute("href", `/${path}/fixture`);
    await expect(link).toHaveCSS("text-decoration-line", "underline");
    await card.getByText("Resource description", { exact: true }).click();
    await expect(page).toHaveURL(`${base}/${path}`);
    await link.focus();
    await expect(link).toBeFocused();
    const popup = page.context().waitForEvent("page");
    await link.click({ button: "middle" });
    const opened = await popup;
    await expect(opened).toHaveURL(`${base}/${path}/fixture`);
    await opened.close();
  });
}

test("Members and Models share the same explicit usage link", async ({ page }) => {
  const styles: unknown[] = [];
  for (const path of ["members", "models"]) {
    await page.goto(`${base}/${path}`);
    const link = page.getByRole("link", { name: "View usage", exact: true });
    await expect(link).toHaveAttribute("href", path === "members" ? "/usage?user=viewer" : "/models/usage?model=fixture%2Fmodel");
    styles.push(await link.evaluate(element => { const css = getComputedStyle(element); return [css.color, css.fontSize, css.fontWeight, css.textDecorationLine]; }));
    await expect(page.getByRole("link", { name: path === "members" ? "Fixture member" : "Fixture model", exact: true })).toHaveCount(0);
  }
  expect(styles[0]).toEqual(styles[1]);
});
