import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { test, expect } from "@playwright/test";
import type { CapabilityVisibilityView } from "../src/application/plugin/capabilityVisibility";
import type { CapabilityUsageChange } from "../src/domain/plugin/visibility";

let server: Server;
let base: string;
let view: CapabilityVisibilityView;
let writes: CapabilityUsageChange[][];
let failLoad: boolean;
let failSave: boolean;

test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["browser-tests/fixtures/capability-visibility.tsx"], bundle: true, write: false,
    outdir: "/tmp/agent-studio-visibility-fixture", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
    plugins: [{ name: "next-navigation", setup(build) {
      build.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "next-stub" }));
      build.onLoad({ filter: /.*/, namespace: "next-stub" }, () => ({ contents: "export const usePathname = () => location.pathname;", loader: "js" }));
    } }] });
  server = createServer((request, response) => {
    const file = bundle.outputFiles.find(file => request.url === `/${file.path.split("/").at(-1)}`);
    response.setHeader("Content-Type", `${file ? file.path.endsWith(".css") ? "text/css" : "text/javascript" : "text/html"}; charset=utf-8`);
    response.end(file?.contents ?? '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/capability-visibility.css"><div id="root"></div><script src="/capability-visibility.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
test.beforeEach(async ({ page }) => {
  page.on("pageerror", error => { throw error; });
  view = { hidden: { plugins: [], skills: ["deploy", "retired"], tools: [] },
    plugins: [{ name: "devops", description: "Deployment helpers" }],
    skills: [{ name: "deploy", description: "Deploy applications", plugin: "devops" }, { name: "manual", description: "Manual skill" }],
    tools: [{ name: "cluster", description: "Cluster operations", plugin: "devops" }] };
  writes = []; failLoad = false; failSave = false;
  await page.route("**/api/settings", route => route.fulfill({ json: {
    fields: { pluginsRepo: { value: "fixture/plugins", source: "override", secret: false },
      pluginsRepoBranch: { value: "main", source: "default", secret: false }, githubToken: { value: "", source: "unset", secret: true } },
    serviceLogos: [], llmProviders: { source: "override", items: [] },
  } }));
  await page.route("**/api/settings/plugins/visibility", route => {
    if (route.request().method() === "PATCH") {
      if (failSave) return route.fulfill({ status: 503, json: { error: "Settings unavailable" } });
      const { changes } = route.request().postDataJSON() as { changes: CapabilityUsageChange[] };
      writes.push(changes);
      for (const change of changes) {
        view.hidden[change.kind] = change.enabled
          ? view.hidden[change.kind].filter(name => name !== change.name)
          : [...new Set([...view.hidden[change.kind], change.name])];
      }
    } else if (failLoad) return route.fulfill({ status: 503, json: { error: "Settings unavailable" } });
    return route.fulfill({ json: view });
  });
});

test("saves Plugin usage changes, restores them on reload, and preserves independent Skill/Tool choices", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(base);
  await page.getByRole("checkbox", { name: "Use devops", exact: true }).uncheck();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("tab", { name: "Skills", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Use deploy", exact: true })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Use deploy", exact: true })).toBeDisabled();
  await expect(page.getByText("devops is disabled", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Use retired", exact: true })).not.toBeChecked();
  await page.getByRole("tab", { name: "Tools", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Use cluster", exact: true })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Use cluster", exact: true })).toBeDisabled();
  await page.getByRole("tab", { name: "Plugins", exact: true }).click();
  await page.getByRole("checkbox", { name: "Use devops", exact: true }).check();
  await page.getByRole("tab", { name: "Tools", exact: true }).click();
  await page.getByRole("checkbox", { name: "Use cluster", exact: true }).uncheck();
  await page.getByRole("tab", { name: "Skills", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Use deploy", exact: true })).toBeEnabled();
  await expect(page.getByRole("checkbox", { name: "Use deploy", exact: true })).not.toBeChecked();
  await page.getByRole("checkbox", { name: "Use retired", exact: true }).check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect(writes).toEqual([[{ kind: "plugins", name: "devops", enabled: false }],
    [{ kind: "plugins", name: "devops", enabled: true }, { kind: "skills", name: "retired", enabled: true }, { kind: "tools", name: "cluster", enabled: false }]]);
  expect(errors).toEqual([]);
});

test("retries a failed read and retains unsaved selections after a failed save", async ({ page }) => {
  failLoad = true;
  await page.goto(base);
  await expect(page.getByRole("alert")).toContainText("Settings unavailable");
  failLoad = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page.getByRole("checkbox", { name: "Use devops", exact: true }).uncheck();
  failSave = true;
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Settings unavailable");
  await expect(page.getByRole("checkbox", { name: "Use devops", exact: true })).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  expect(writes).toEqual([]);
  failSave = false;
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
});

test("renders Korean labels and searches capabilities on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/ko`);
  await expect(page.getByRole("heading", { name: "사용 설정" })).toBeVisible();
  await page.getByRole("tab", { name: "Skills", exact: true }).click();
  await page.getByRole("textbox", { name: "기능 검색", exact: true }).fill("Manual");
  await expect(page.getByRole("checkbox", { name: "manual 사용", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "deploy 사용", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/agent-studio-visibility-ko.png", fullPage: true });
});

test("places Plugin usage and sync settings below the shared Settings tabs", async ({ page }) => {
  await page.goto(`${base}/settings/plugins`);
  const main = page.getByRole("tablist", { name: "Settings", exact: true });
  const section = page.getByRole("tablist", { name: "Plugins", exact: true });
  await expect(main.getByRole("tab", { name: "Plugins", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(section.getByRole("tab", { name: "Usage settings", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(section.getByRole("tab", { name: "Sync settings", exact: true })).toHaveAttribute("href", "/settings/plugins/sync");
  await expect(section.getByRole("tab")).toHaveCount(2);
  await page.screenshot({ path: "/tmp/agent-studio-plugin-settings-tabs.png", fullPage: true });
  await section.getByRole("tab", { name: "Sync settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sync settings", exact: true })).toBeVisible();
  await expect(section.getByRole("tab", { name: "Sync settings", exact: true })).toHaveAttribute("aria-current", "page");
});

test("checks all Plugin, Skill and Tool usage controls by default", async ({ page }) => {
  view.hidden = { plugins: [], skills: [], tools: [] };
  await page.goto(base);
  await expect(page.getByRole("checkbox", { name: "Use devops", exact: true })).toBeChecked();
  await page.getByRole("tab", { name: "Skills", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Use deploy", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Use manual", exact: true })).toBeChecked();
  await page.getByRole("tab", { name: "Tools", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Use cluster", exact: true })).toBeChecked();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
});

test("preserves an administrator's Tool change while saving edits from an older Plugin page", async ({ page }) => {
  await page.goto(base);
  await page.getByRole("checkbox", { name: "Use devops", exact: true }).uncheck();
  view.hidden.tools = ["cluster"];
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(view.hidden).toEqual({ plugins: ["devops"], skills: ["deploy", "retired"], tools: ["cluster"] });
  expect(writes).toEqual([[{ kind: "plugins", name: "devops", enabled: false }]]);
});
