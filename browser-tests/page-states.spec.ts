import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { test, expect } from "@playwright/test";
import { translator } from "../src/app/_i18n/translate";

let server: Server;
let base: string;
test.use({ viewport: { width: 390, height: 844 } });
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["browser-tests/fixtures/page-states.tsx"], bundle: true, write: false,
    outdir: "/tmp/agent-studio-page-states", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
    plugins: [{ name: "navigation", setup(build) {
      build.onResolve({ filter: /^next\/navigation$/ }, args => ({ path: args.path, namespace: "navigation" }));
      build.onLoad({ filter: /.*/, namespace: "navigation" }, () => ({ contents: 'export const useParams = () => ({ name: "fixture" });', loader: "js" }));
    } }],
  });
  server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const file = bundle.outputFiles.find(item => path === `/${item.path.split("/").at(-1)}`);
    response.setHeader("Content-Type", `${file ? file.path.endsWith(".css") ? "text/css" : "text/javascript" : "text/html"}; charset=utf-8`);
    response.end(file?.contents ?? '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/page-states.css"><div id="root"></div><script src="/page-states.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

for (const [route, title] of [["audio", "audio.title"], ["workspace", "workspace.toolsTitle"]] as const) {
  for (const state of ["loading", "disabled", "error"]) {
    test(`${route} keeps its heading while ${state} without loading protected data`, async ({ page }) => {
      const requests: string[] = [];
      await page.route("**/api/**", request => { requests.push(request.request().url()); return request.abort(); });
      await page.goto(`${base}?page=${route}&state=${state}`);
      await expect(page.getByRole("heading", { level: 2, name: translator("en")(title), exact: true })).toBeVisible();
      if (state === "loading") await expect(page.getByRole("status")).toContainText("Loading");
      else await expect(page.getByRole("alert")).toBeVisible();
      expect(requests).toEqual([]);
    });
  }
}

for (const [routeName, title, endpoint] of [["profile", "Profile", "me/profile"], ["members", "Members", "members"], ["audits", "Audits", "audits"]] as const) {
  test(`${title} keeps its header through loading and failed reads`, async ({ page }) => {
    let release: (() => void) | undefined;
    await page.route("**/api/**", route => route.fulfill({ json: { items: [] } }));
    await page.route(`**/api/${endpoint}*`, async route => {
      await new Promise<void>(resolve => { release = resolve; });
      await route.fulfill({ status: 500, json: { error: "Synthetic read failed" } });
    });
    try {
      await page.goto(`${base}?page=${routeName}`);
      const heading = page.getByRole("heading", { level: 1, name: title });
      await expect(heading).toBeVisible();
      await expect(page.locator("main header svg")).toHaveCount(1);
      await expect(page.getByRole("status")).toContainText("Loading");
      await expect.poll(() => Boolean(release)).toBe(true);
      release!();
      await expect(page.getByRole("alert").filter({ hasText: "Synthetic read failed" })).toBeVisible();
      await expect(heading).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { release?.(); }
  });
}

for (const [routeName, title] of [["members", "Members"], ["audits", "Audits"]] as const) {
  test(`${title} keeps page context when the viewer lacks permission`, async ({ page }) => {
    const requests: string[] = [];
    await page.route("**/api/**", route => { requests.push(route.request().url()); return route.fulfill({ status: 403, json: { error: "Forbidden" } }); });
    await page.goto(`${base}?page=${routeName}&role=guest`);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(page.getByRole("alert")).toBeVisible();
    expect(requests).toEqual([]);
  });
}
