import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { test, expect } from "@playwright/test";
import { A2A_PROTOCOL_VERSION } from "@a2a-js/sdk";
import type { ProjectA2aResponse } from "../src/app/api/projects/[name]/a2a/route";
import type { A2aProjectListResponse } from "../src/app/api/a2a/route";

let server: Server;
let base: string;
let enabled: boolean;
let preview: ProjectA2aResponse;
let previewError: string | null;
let previewReads: string[];
let publicReads: string[];
let publicStatus: number;
const PUBLIC_URL = "https://cards.example.test/api/a2a/fixture/.well-known/agent-card.json";
const CARD: NonNullable<ProjectA2aResponse["card"]> = {
  name: "Authorized preview", description: "Accessible Studio project",
  supportedInterfaces: [{ url: "https://studio.example.test/api/a2a/fixture", protocolBinding: "JSONRPC", tenant: "", protocolVersion: A2A_PROTOCOL_VERSION }],
  provider: undefined, version: "1.0.0", capabilities: { streaming: true, extensions: [] },
  defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"], skills: [],
  securitySchemes: {}, securityRequirements: [], signatures: [],
};

test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["browser-tests/fixtures/agent-cards.tsx"], bundle: true, write: false,
    outdir: "/tmp/agent-studio-agent-card-fixture", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" } });
  server = createServer((request, response) => {
    const file = bundle.outputFiles.find(file => request.url === `/${file.path.split("/").at(-1)}`);
    response.setHeader("Content-Type", `${file ? file.path.endsWith(".css") ? "text/css" : "text/javascript" : "text/html"}; charset=utf-8`);
    response.end(file?.contents ?? '<link rel="stylesheet" href="/agent-cards.css"><div id="root"></div><script src="/agent-cards.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
test.beforeEach(async ({ page }) => {
  enabled = true; previewError = null; previewReads = []; publicReads = []; publicStatus = 404;
  preview = { enabled: true, configured: true, cardUrl: PUBLIC_URL, card: CARD };
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/agents") return route.fulfill({ json: [] });
    if (path === "/api/a2a") return route.fulfill({ json: {
      enabled, projects: [{ name: "fixture", displayName: "Studio fixture", description: "Preview this project", cardUrl: PUBLIC_URL }],
    } satisfies A2aProjectListResponse });
    if (path === "/api/projects/fixture/a2a") {
      previewReads.push(path);
      return previewError ? route.fulfill({ status: 404, json: { error: previewError } }) : route.fulfill({ json: preview });
    }
    if (path === "/api/a2a/fixture/.well-known/agent-card.json") {
      publicReads.push(route.request().url());
      return route.fulfill({ status: publicStatus, json: publicStatus === 200 ? CARD : { error: "Public card unavailable" } });
    }
    return route.abort();
  });
});
test.afterEach(() => {
  expect(previewReads).toEqual(["/api/projects/fixture/a2a"]);
  expect(publicReads).toEqual([]);
});

test("previews an accessible private project even when its public card returns 404", async ({ page }) => {
  preview = { ...preview, cardUrl: null };
  await page.goto(base);
  await page.getByRole("button", { name: /Studio fixture/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("pre")).toHaveText(JSON.stringify(CARD, null, 2));
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByText(PUBLIC_URL, { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Copy", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("link", { name: "Open project →" })).toHaveAttribute("href", "/projects/fixture");
});

test("previews the card with inbound A2A disabled and omits an unavailable public URL", async ({ page }) => {
  enabled = false;
  publicStatus = 503;
  preview = { ...preview, enabled: false, cardUrl: null };
  await page.goto(base);
  await page.getByRole("button", { name: /Studio fixture/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("pre")).toHaveText(JSON.stringify(CARD, null, 2));
  await expect(dialog.getByText(PUBLIC_URL, { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Copy", exact: true })).toHaveCount(0);
});

test("keeps the current public card URL copyable without fetching it", async ({ page, context }) => {
  const currentUrl = "https://current.example.test/api/a2a/fixture/.well-known/agent-card.json";
  publicStatus = 200;
  preview = { ...preview, cardUrl: currentUrl };
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  await page.goto(base);
  await page.getByRole("button", { name: /Studio fixture/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(currentUrl, { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Copy", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(currentUrl);
});

test("shows a project-read refusal without falling back to the public endpoint", async ({ page }) => {
  previewError = "Project not found";
  await page.goto(base);
  await page.getByRole("button", { name: /Studio fixture/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toHaveText(previewError);
  await expect(dialog.locator("pre")).toHaveCount(0);
});

test("settles a preview when the project's saved configuration was removed", async ({ page }) => {
  preview = { enabled: true, configured: false, cardUrl: null, card: null };
  await page.goto(base);
  await page.getByRole("button", { name: /Studio fixture/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toHaveText("No Agent Card is available for this project");
  await expect(dialog.getByText("Loading…", { exact: true })).toHaveCount(0);
});
