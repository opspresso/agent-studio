import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { test, expect } from "@playwright/test";
import type { CapabilityVisibilityView } from "../src/application/plugin/capabilityVisibility";
import type { CapabilityVisibility } from "../src/domain/plugin/visibility";

let server: Server;
let base: string;
let view: CapabilityVisibilityView;
let writes: CapabilityVisibility[];
let failLoad: boolean;
let failSave: boolean;

test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["browser-tests/fixtures/capability-visibility.tsx"], bundle: true, write: false,
    outdir: "/tmp/agent-studio-visibility-fixture", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' } });
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
  view = { hidden: { plugins: [], skills: ["deploy", "retired"], tools: [] },
    plugins: [{ name: "devops", description: "Deployment helpers" }],
    skills: [{ name: "deploy", description: "Deploy applications", plugin: "devops" }, { name: "manual", description: "Manual skill" }],
    tools: [{ name: "cluster", description: "Cluster operations", plugin: "devops" }] };
  writes = []; failLoad = false; failSave = false;
  await page.route("**/api/settings/plugins/visibility", route => {
    if (route.request().method() === "PUT") {
      if (failSave) return route.fulfill({ status: 503, json: { error: "Settings unavailable" } });
      view.hidden = route.request().postDataJSON() as CapabilityVisibility;
      writes.push(view.hidden);
    } else if (failLoad) return route.fulfill({ status: 503, json: { error: "Settings unavailable" } });
    return route.fulfill({ json: view });
  });
});

test("saves parent hiding, restores it on reload, and preserves independent skill/tool choices", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(base);
  await page.getByRole("checkbox", { name: "Hide devops", exact: true }).check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("tab", { name: "Skills", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Hide deploy", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Hide deploy", exact: true })).toBeDisabled();
  await expect(page.getByText("Hidden by devops", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Hide retired", exact: true })).toBeChecked();
  await page.getByRole("tab", { name: "Tools", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Hide cluster", exact: true })).toBeDisabled();
  await page.getByRole("tab", { name: "Plugins", exact: true }).click();
  await page.getByRole("checkbox", { name: "Hide devops", exact: true }).uncheck();
  await page.getByRole("tab", { name: "Tools", exact: true }).click();
  await page.getByRole("checkbox", { name: "Hide cluster", exact: true }).check();
  await page.getByRole("tab", { name: "Skills", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Hide deploy", exact: true })).toBeEnabled();
  await page.getByRole("checkbox", { name: "Hide retired", exact: true }).uncheck();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect(writes).toEqual([{ plugins: ["devops"], skills: ["deploy", "retired"], tools: [] },
    { plugins: [], skills: ["deploy"], tools: ["cluster"] }]);
  expect(errors).toEqual([]);
});

test("retries a failed read and retains unsaved selections after a failed save", async ({ page }) => {
  failLoad = true;
  await page.goto(base);
  await expect(page.getByRole("alert")).toContainText("Settings unavailable");
  failLoad = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page.getByRole("checkbox", { name: "Hide devops", exact: true }).check();
  failSave = true;
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Settings unavailable");
  await expect(page.getByRole("checkbox", { name: "Hide devops", exact: true })).toBeChecked();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  expect(writes).toEqual([]);
  failSave = false;
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
});

test("renders Korean labels and searches capabilities on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/ko`);
  await expect(page.getByRole("heading", { name: "숨긴 기능" })).toBeVisible();
  await page.getByRole("tab", { name: "Skills", exact: true }).click();
  await page.getByRole("textbox", { name: "기능 검색", exact: true }).fill("Manual");
  await expect(page.getByRole("checkbox", { name: "manual 숨기기", exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "deploy 숨기기", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/agent-studio-visibility-ko.png", fullPage: true });
});
