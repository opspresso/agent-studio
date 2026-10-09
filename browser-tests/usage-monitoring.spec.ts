import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { test, expect, type Page } from "@playwright/test";

let server: Server;
let base: string;
const model = "selfhosted/model.v1";
const other = "selfhosted/free";
const rows = [
  { userId: "alice", agentName: "agent", date: "2026-10-09", calls: { [model]: 2 }, inputTokens: { [model]: 10 },
    outputTokens: { [model]: 1000 }, costUsd: { [model]: 1 }, modelDurationMs: { [model]: 1000 }, timedOutputTokens: { [model]: 100 }, timedCalls: { [model]: 1 } },
  { userId: "bob", agentName: "agent", date: "2026-10-09", calls: { [model]: 1, [other]: 1 }, inputTokens: { [model]: 20 },
    outputTokens: { [model]: 100, [other]: 30 }, costUsd: { [model]: 2, [other]: 0 },
    modelDurationMs: { [model]: 3000 }, timedOutputTokens: { [model]: 100 }, timedCalls: { [model]: 1 } },
];
const members = ["alice", "bob", "silent"].map(id => ({ id, name: id.toUpperCase(), email: `${id}@example.test` }));

test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["browser-tests/fixtures/usage-monitoring.tsx"], bundle: true, write: false,
    outdir: "/tmp/agent-studio-usage-monitoring-fixture", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
    plugins: [{ name: "dynamic", setup(build) {
      build.onResolve({ filter: /^next\/dynamic$/ }, args => ({ path: args.path, namespace: "dynamic" }));
      build.onLoad({ filter: /.*/, namespace: "dynamic" }, () => ({
        contents: 'import React from "react"; export default function dynamic(load, opts) { const View = React.lazy(load); return props => React.createElement(React.Suspense, { fallback: React.createElement(opts.loading) }, React.createElement(View, props)); }',
        loader: "js", resolveDir: process.cwd(),
      }));
    } }],
  });
  server = createServer((request, response) => {
    const file = bundle.outputFiles.find(file => request.url === `/${file.path.split("/").at(-1)}`);
    response.setHeader("Content-Type", `${file ? file.path.endsWith(".css") ? "text/css" : "text/javascript" : "text/html"}; charset=utf-8`);
    response.end(file?.contents ?? '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/usage-monitoring.css"><div id="root"></div><script src="/usage-monitoring.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

async function fixtures(page: Page) {
  await page.clock.install({ time: new Date("2026-10-09T12:00:00Z") });
  await page.route("**/api/usages/summary?**", route => route.fulfill({ json: { items: rows } }));
  await page.route("**/api/usages/members?**", route => route.fulfill({ json: { items: rows, members } }));
}

test("models show weighted throughput, sample coverage and a real daily graph", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await fixtures(page);
  await page.goto(base);
  const row = page.getByRole("row").filter({ hasText: model });
  await expect(row.getByRole("cell", { name: "50", exact: true })).toBeVisible();
  await expect(row.getByRole("cell", { name: "2 / 3", exact: true })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: other }).getByRole("cell", { name: "—", exact: true })).toHaveCount(2);
  await page.getByRole("combobox", { name: "Chart metric" }).click();
  await page.getByRole("option", { name: "Output tokens/s", exact: true }).click();
  await expect(page.locator(".recharts-bar-rectangle").first()).toBeVisible();
  await page.screenshot({ path: "/tmp/agent-studio-model-throughput.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("administrators compare all users and drill down by user and model", async ({ page }) => {
  await fixtures(page);
  await page.goto(`${base}?admin`);
  await expect(page.getByRole("button", { name: "SILENT (silent@example.test)" })).toBeVisible();
  await page.getByRole("button", { name: "ALICE (alice@example.test)" }).click();
  const row = page.getByRole("row").filter({ hasText: model });
  await expect(row.getByRole("cell", { name: "100", exact: true })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: other })).toHaveCount(0);
  await page.getByRole("button", { name: model, exact: true }).click();
  await expect(page.getByRole("combobox", { name: "model", exact: true })).toHaveValue(model);
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByRole("row").filter({ hasText: other })).toBeVisible();
  await page.screenshot({ path: "/tmp/agent-studio-admin-usage.png", fullPage: true });
});

test("members cannot request the administrator ledger", async ({ page }) => {
  let reads = 0;
  await page.route("**/api/usages/members?**", route => { reads++; return route.fulfill({ json: { items: rows, members } }); });
  await page.goto(`${base}?admin&restricted`);
  await expect(page.getByRole("heading", { level: 1, name: "Usage monitoring" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Only administrators");
  expect(reads).toBe(0);
});

test("keeps the page heading while administrator access is being resolved", async ({ page }) => {
  let reads = 0;
  await page.route("**/api/usages/members?**", route => { reads++; return route.fulfill({ json: { items: [], members: [] } }); });
  await page.goto(`${base}?admin&viewerLoading`);
  await expect(page.getByRole("heading", { level: 1, name: "Usage monitoring" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Loading");
  expect(reads).toBe(0);
});

test("unmeasured model usage is distinct from zero throughput", async ({ page }) => {
  await fixtures(page);
  await page.goto(`${base}?model=${encodeURIComponent(other)}`);
  await expect(page.getByRole("row").filter({ hasText: other })).toBeVisible();
  await page.getByRole("combobox", { name: "Chart metric" }).click();
  await page.getByRole("option", { name: "Output tokens/s", exact: true }).click();
  await expect(page.getByText("No measured model calls in this period.", { exact: true })).toBeVisible();
  await expect(page.locator(".recharts-bar-rectangle")).toHaveCount(0);
});

test("failed reads stay unknown and can be retried", async ({ page }) => {
  await fixtures(page);
  let reads = 0;
  await page.route("**/api/usages/summary?**", route => route.fulfill(++reads === 1
    ? { status: 503, json: { error: "Usage store unavailable" } } : { json: { items: rows } }));
  await page.goto(base);
  await expect(page.getByRole("alert")).toContainText("Usage store unavailable");
  await expect(page.getByRole("row").filter({ hasText: "Usage could not be loaded." })).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("row").filter({ hasText: model })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("Korean mobile view keeps the wide table inside its scroll container", async ({ page }) => {
  await fixtures(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}?admin&ko`);
  await expect(page.getByRole("heading", { name: "사용량 모니터링" })).toBeVisible();
  await expect(page.getByRole("button", { name: "BOB (bob@example.test)" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/agent-studio-usage-mobile.png", fullPage: true });
});

test("paginates user rows while keeping totals and zero-usage accounts complete", async ({ page }) => {
  await fixtures(page);
  const accounts = Array.from({ length: 31 }, (_, i) => ({ id: `u${String(i).padStart(2, "0")}`, name: `Member ${i}`, email: `m${i}@test.example` }));
  await page.route("**/api/usages/members?**", route => route.fulfill({ json: { members: accounts,
    items: [{ ...rows[0], userId: "u30" }] } }));
  await page.goto(`${base}?admin`);
  await expect(page.getByRole("row")).toHaveCount(26);
  await expect(page.getByRole("button", { name: "Previous page", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Member 30 (m30@test.example)" })).toBeVisible();
  await page.getByRole("button", { name: "Page 2", exact: true }).click();
  await expect(page.getByRole("row")).toHaveCount(7);
  await expect(page.getByRole("button", { name: "Page 2", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Member 29 (m29@test.example)" })).toBeVisible();
});

test("a newer date range keeps its totals when an older request resolves late", async ({ page }) => {
  await fixtures(page);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let requested!: () => void;
  const first = new Promise<void>(resolve => { requested = resolve; });
  await page.route("**/api/usages/summary?**", async route => {
    if (new URL(route.request().url()).searchParams.get("from") === "2026-09-10") {
      requested(); await pending;
      await route.fulfill({ json: { items: [{ ...rows[0], costUsd: { [model]: 999 } }] } });
    } else await route.fulfill({ json: { items: [rows[0]] } });
  });
  await page.goto(base);
  await first;
  await page.getByRole("button", { name: "7d", exact: true }).click();
  const row = page.getByRole("row").filter({ hasText: model });
  await expect(row.getByRole("cell", { name: "$1.00", exact: true })).toBeVisible();
  release();
  await expect(row.getByRole("cell", { name: "$1.00", exact: true })).toBeVisible();
});
