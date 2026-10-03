import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { test, expect } from "@playwright/test";
import type { PluginSyncResult } from "../src/domain/plugin/sync";

let server: Server;
let base: string;
const report = (orphaned: boolean): PluginSyncResult => ({ repo: "fixture/plugins", commitSha: "a".repeat(40),
  plugins: [], skipped: [], orphanedPlugins: orphaned ? ["retired-plugin"] : [], removedPlugins: orphaned ? [] : ["retired-plugin"] });

test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["browser-tests/fixtures/plugin-sync.tsx"], bundle: true, write: false,
    outdir: "/tmp/agent-studio-plugin-sync-fixture", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
    plugins: [{ name: "next-link", setup(build) {
      build.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "next-stub" }));
      build.onLoad({ filter: /.*/, namespace: "next-stub" }, () => ({ contents:
        'import {createElement} from "react"; export default function Link({href, children, ...props}) { return createElement("a", {...props, href}, children); }',
        loader: "js", resolveDir: process.cwd() }));
    } }] });
  server = createServer((request, response) => {
    const file = bundle.outputFiles.find(file => request.url === `/${file.path.split("/").at(-1)}`);
    response.setHeader("Content-Type", `${file ? file.path.endsWith(".css") ? "text/css" : "text/javascript" : "text/html"}; charset=utf-8`);
    response.end(file?.contents ?? '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/plugin-sync.css"><div id="root"></div><script src="/plugin-sync.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); });

for (const source of ["github", "archive"] as const) {
  test(`serializes ${source} deletion with source changes and releases controls after completion`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    let posts = 0;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const urls: string[] = [];
    await page.route("**/api/plugins", route => route.fulfill({ json: [] }));
    await page.route("**/api/plugins/sync**", async route => {
      if (route.request().method() === "GET") return route.fulfill({ json: { configured: true, repo: "fixture/plugins", branch: "main" } });
      urls.push(route.request().url());
      if (++posts === 2) await pending;
      return route.fulfill({ json: report(posts === 1) });
    });
    await page.goto(base);
    const github = page.getByRole("button", { name: "Sync from GitHub", exact: true });
    const upload = page.getByRole("button", { name: "Upload archive", exact: true });
    if (source === "github") await github.click();
    else await page.locator('input[type="file"]').setInputFiles({ name: "fixture.tar", mimeType: "application/x-tar", buffer: Buffer.from("fixture") });
    const checkbox = page.getByRole("checkbox", { name: "retired-plugin", exact: true });
    await checkbox.check();
    await page.getByRole("button", { name: "Delete 1 entry", exact: true }).click();
    await expect.poll(() => posts).toBe(2);
    try {
      await expect(github).toBeDisabled();
      await expect(upload).toBeDisabled();
      await expect(checkbox).toBeDisabled();
      // A file-picker callback can arrive after another operation has started.
      await page.locator('input[type="file"]').setInputFiles({ name: "late.tar", mimeType: "application/x-tar", buffer: Buffer.from("late") });
      expect(posts).toBe(2);
      await expect(checkbox).toBeChecked();
      expect(urls[1]).toBe(urls[0]);
      await page.screenshot({ path: `/tmp/agent-studio-plugin-sync-${source}-pending.png`, fullPage: true });
    } finally { release(); }
    await expect(checkbox).toHaveCount(0);
    await expect(github).toBeEnabled();
    await expect(upload).toBeEnabled();
    await github.click();
    await expect.poll(() => posts).toBe(3);
    expect(urls[2]).toMatch(/\/api\/plugins\/sync$/);
    await expect(page.getByText(/fixture\.tar/)).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test("keeps reviewed choices after a refused deletion and re-enables source controls", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let posts = 0;
  await page.route("**/api/plugins", route => route.fulfill({ json: [] }));
  await page.route("**/api/plugins/sync", route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { configured: true, repo: "fixture/plugins", branch: "main" } });
    return ++posts === 2 ? route.fulfill({ status: 503, json: { error: "Delete refused" } }) : route.fulfill({ json: report(posts === 1) });
  });
  await page.goto(base);
  const github = page.getByRole("button", { name: "Sync from GitHub", exact: true });
  await github.click();
  const checkbox = page.getByRole("checkbox", { name: "retired-plugin", exact: true });
  await checkbox.check();
  const remove = page.getByRole("button", { name: "Delete 1 entry", exact: true });
  await remove.click();
  await expect(page.getByText("Delete refused", { exact: true })).toBeVisible();
  await expect(checkbox).toBeChecked();
  await expect(checkbox).toBeEnabled();
  await expect(remove).toBeEnabled();
  await expect(github).toBeEnabled();
  await expect(page.getByRole("button", { name: "Upload archive", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/agent-studio-plugin-sync-failure-mobile.png", fullPage: true });
  await github.click();
  await expect(checkbox).toHaveCount(0);
  await expect(page.getByText("Delete refused", { exact: true })).toHaveCount(0);
});
