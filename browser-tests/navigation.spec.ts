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
      "/api/members": { members: [{ id: "viewer", name: "Fixture member", email: "viewer@example.test", tier: "admin", joinedAt: at, tierLocked: false }], tiers: ["admin", "member"] },
      "/api/models/registry": { models: [{ id: "fixture/model", provider: "fixture", wireId: "model", displayName: "Fixture model", type: "text", capabilities: {}, contextWindow: 1000, maxTokens: 100 }] },
      "/api/models/favorites": { models: [] },
    };
    return path in responses ? route.fulfill({ json: responses[path] }) : route.abort();
  });
});

for (const view of ["Rows", "Grid"]) for (const width of [390, 1440]) for (const path of ["agents", "skills", "tools", "plugins"]) {
  test(`${path} opens the whole card with a native link in ${view} at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${base}/${path}`);
    await page.getByRole("radio", { name: view, exact: true }).locator("..").click();
    const card = page.locator("main article").first();
    const link = card.getByRole("link", { name: path === "agents" ? "Fixture Agent" : "fixture", exact: true });
    await expect(link).toHaveAttribute("href", `/${path}/fixture`);
    await expect(link).toHaveCSS("text-decoration-line", "none");
    await link.focus();
    await expect(link).toBeFocused();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(link).toBeFocused();
    expect(await link.evaluate(element => ({ visible: element.matches(":focus-visible"), width: getComputedStyle(element, "::after").outlineWidth, style: getComputedStyle(element, "::after").outlineStyle }))).toEqual({ visible: true, width: "2px", style: "solid" });
    const popup = page.context().waitForEvent("page");
    await link.click({ button: "middle" });
    const opened = await popup;
    await expect(opened).toHaveURL(`${base}/${path}/fixture`);
    await opened.close();
    // Hit the description's position, where the stretched native link receives the click.
    const description = await card.getByText("Resource description", { exact: true }).boundingBox();
    await page.mouse.click(description!.x + 10, description!.y + 10);
    await expect(page).toHaveURL(`${base}/${path}/fixture`);
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

for (const path of ["members", "models"]) test(`${path} row navigation keeps secondary controls independent`, async ({ page }) => {
  await page.goto(`${base}/${path}`);
  const row = page.getByRole("row").filter({ hasText: path === "members" ? "Fixture member" : "Fixture model" });
  if (path === "members") {
    await row.getByRole("combobox", { name: "Tier of viewer@example.test" }).click();
    await expect(page.getByRole("option", { name: "member", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
  } else {
    let saved = false;
    await page.route("**/api/models/favorites", route => { saved = true; return route.fulfill({ json: { models: ["fixture/model"] } }); });
    await row.getByRole("button", { name: "Add to favorites" }).click();
    await expect.poll(() => saved).toBe(true);
  }
  await expect(page).toHaveURL(`${base}/${path}`);
  const primary = row.getByRole("link", { name: "View usage", exact: true });
  await primary.focus();
  await expect(primary).toBeFocused();
  const name = await row.getByText(path === "members" ? "Fixture member" : "Fixture model", { exact: true }).boundingBox();
  await page.mouse.click(name!.x + 10, name!.y + 10);
  await expect(page).toHaveURL(new RegExp(path === "members" ? "/usage\\?user=viewer" : "/models/usage\\?model=fixture%2Fmodel"));
});
