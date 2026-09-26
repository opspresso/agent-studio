import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { test, expect } from "@playwright/test";

let server: Server;
let base: string;
let pageErrors: string[];

test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["browser-tests/fixtures/agent-suggestion.tsx"], bundle: true, write: false,
    outdir: "/tmp/agent-studio-suggestion-fixture", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" } });
  server = createServer((request, response) => {
    const file = bundle.outputFiles.find(file => request.url === `/${file.path.split("/").at(-1)}`);
    response.setHeader("Content-Type", `${file ? file.path.endsWith(".css") ? "text/css" : "text/javascript" : "text/html"}; charset=utf-8`);
    response.end(file?.contents ?? '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/agent-suggestion.css"><div id="root"></div><script src="/agent-suggestion.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
test.beforeEach(async ({ page }) => { pageErrors = []; page.on("pageerror", error => pageErrors.push(error.message)); });
test.afterEach(() => { expect(pageErrors).toEqual([]); });

test("debounces a suggestion, applies it explicitly and discards an old surface result", async ({ page }) => {
  const seen: Array<{ surface: string; request: string }> = [];
  await page.route("**/api/agent-recommendations", async route => {
    const body = route.request().postDataJSON() as { surface: string; request: string };
    seen.push(body);
    await route.fulfill({ json: { recommendation: { name: body.surface === "chat" ? "coder" : "writer", confidence: 0.8 } } });
  });
  await page.goto(base);
  await page.getByRole("textbox", { name: "Request" }).fill("Please fix this code");
  await expect(page.getByRole("status")).toContainText("Coder");
  await expect(page.getByText("Selected: writer")).toBeVisible();
  await page.getByRole("button", { name: "Use Agent" }).click();
  await expect(page.getByText("Selected: coder")).toBeVisible();
  await page.getByRole("button", { name: "Switch surface" }).click();
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Writer");
  expect(seen).toEqual([
    { surface: "chat", request: "Please fix this code" },
    { surface: "workspace", request: "Please fix this code" },
  ]);
});

test("keeps the previous suggestion while a changed request waits for another result", async ({ page }) => {
  let nextRequested!: () => void;
  const nextSeen = new Promise<void>(resolve => { nextRequested = resolve; });
  let releaseNext!: () => void;
  const held = new Promise<void>(resolve => { releaseNext = resolve; });
  await page.route("**/api/agent-recommendations", async route => {
    const { request } = route.request().postDataJSON() as { request: string };
    if (request === "Please fix this code") {
      return route.fulfill({ json: { recommendation: { name: "coder", confidence: 0.8 } } });
    }
    nextRequested();
    await held;
    return route.fulfill({ json: { recommendation: { name: "writer", confidence: 0.8 } } });
  });
  try {
    await page.goto(base);
    const request = page.getByRole("textbox", { name: "Request" });
    await request.fill("Please fix this code");
    await expect(page.getByRole("status")).toContainText("Coder");
    await request.fill("Please draft meeting minutes");
    await expect(page.getByRole("status")).toContainText("Coder");
    await nextSeen;
    await expect(page.getByRole("status")).toContainText("Coder");
    releaseNext();
    await expect(page.getByRole("status")).toContainText("Writer");
  } finally {
    releaseNext();
  }
});

for (const surface of ["chat", "workspace"] as const) {
  test(`suggests within 200ms and keeps evaluating continuous input on ${surface}`, async ({ page }) => {
    const seen: Array<{ surface: string; request: string }> = [];
    await page.clock.install({ time: new Date("2026-09-26T00:00:00Z") });
    await page.clock.pauseAt(new Date("2026-09-26T00:00:01Z"));
    await page.route("**/api/agent-recommendations", route => {
      seen.push(route.request().postDataJSON());
      return route.fulfill({ json: { recommendation: { name: "coder", confidence: 0.8 } } });
    });
    await page.goto(base);
    if (surface === "workspace") await page.getByRole("button", { name: "Switch surface" }).click();
    const input = page.getByRole("textbox", { name: "Request" });
    await input.fill("Fix this code");
    await page.clock.runFor(200);
    await expect(page.getByRole("status")).toContainText("Coder");
    for (let index = 0; index < 20; index++) {
      await input.fill(`Fix this code ${index}`);
      await page.clock.runFor(100);
    }
    await expect.poll(() => seen.length).toBeGreaterThanOrEqual(3);
    expect(seen.every(request => request.surface === surface)).toBe(true);
  });
}

test("finishes a slow recommendation while edits queue only the latest draft", async ({ page }) => {
  const seen: string[] = [];
  let releaseFirst!: () => void;
  const held = new Promise<void>(resolve => { releaseFirst = resolve; });
  await page.clock.install({ time: new Date("2026-09-26T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-09-26T00:00:01Z"));
  await page.route("**/api/agent-recommendations", async route => {
    const { request } = route.request().postDataJSON() as { request: string };
    seen.push(request);
    if (seen.length === 1) await held;
    await route.fulfill({ json: { recommendation: { name: seen.length === 1 ? "coder" : "writer", confidence: 0.8 } } });
  });
  try {
    await page.goto(base);
    const input = page.getByRole("textbox", { name: "Request" });
    await input.fill("Fix code");
    await page.clock.runFor(200);
    await expect.poll(() => seen.length).toBe(1);
    await input.fill("Write a report");
    await input.fill("Write meeting minutes");
    await page.clock.runFor(2_000);
    expect(seen).toEqual(["Fix code"]);
    releaseFirst();
    await expect(page.getByRole("status")).toContainText("Coder");
    await page.clock.runFor(1);
    await expect(page.getByRole("status")).toContainText("Writer");
    expect(seen).toEqual(["Fix code", "Write meeting minutes"]);
  } finally { releaseFirst(); }
});

test("waits for Retry-After before evaluating another edited draft", async ({ page }) => {
  const seen: string[] = [];
  await page.clock.install({ time: new Date("2026-09-26T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-09-26T00:00:01Z"));
  await page.route("**/api/agent-recommendations", route => {
    seen.push((route.request().postDataJSON() as { request: string }).request);
    return seen.length === 1
      ? route.fulfill({ status: 429, headers: { "Retry-After": "3" }, json: { error: "Quota exhausted" } })
      : route.fulfill({ json: { recommendation: { name: "coder", confidence: 0.8 } } });
  });
  await page.goto(base);
  const input = page.getByRole("textbox", { name: "Request" });
  await input.fill("Fix code");
  await page.clock.runFor(200);
  await expect(page.getByRole("alert")).toContainText("Agent suggestion is unavailable");
  await input.fill("Fix the latest code");
  await page.clock.runFor(2_999);
  expect(seen).toEqual(["Fix code"]);
  await page.clock.runFor(1);
  await expect(page.getByRole("status")).toContainText("Coder");
  expect(seen).toEqual(["Fix code", "Fix the latest code"]);
});

test("places Chat suggestions beside the Agent picker and applies them without sending the draft", async ({ page }) => {
  let sends = 0;
  await page.route("**/api/agents", route => route.fulfill({ json: [
    { name: "writer", displayName: "Writer", description: "Write reports" },
    { name: "coder", displayName: "Coder", description: "Fix code" },
  ] }));
  await page.route("**/api/agent-recommendations", route => route.fulfill({ json: { recommendation: { name: "coder", confidence: 0.8 } } }));
  await page.route("**/api/chats**", route => { sends += 1; return route.abort(); });
  await page.goto(`${base}/chat`);
  const picker = page.getByRole("combobox", { name: "Agent", exact: true });
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  await draft.fill("Please fix this code");
  const suggestion = page.getByRole("status").filter({ hasText: "Suggested Agent" });
  await expect(suggestion).toContainText("Coder");
  const pickerBox = (await picker.boundingBox())!;
  const suggestionBox = (await suggestion.boundingBox())!;
  expect(suggestionBox.x).toBeGreaterThan(pickerBox.x + pickerBox.width);
  expect(Math.abs(pickerBox.y + pickerBox.height / 2 - suggestionBox.y - suggestionBox.height / 2)).toBeLessThan(2);
  await page.getByRole("button", { name: "Use Agent", exact: true }).click();
  await expect(picker).toHaveValue("Coder");
  await expect(draft).toHaveValue("Please fix this code");
  expect(sends).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(suggestion).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("selects and clears a registered decision model in model usage settings", async ({ page }) => {
  const saved: Array<string | null> = [];
  await page.route("**/api/models/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/models/default") return route.fulfill({ json: { model: null } });
    if (path === "/api/models/workspace") return route.fulfill({ json: {
      selections: {}, options: { codex: [], claude: [], opencode: [] }, available: [],
    } });
    if (path === "/api/models/catalog") return route.fulfill({ json: {
      providers: [{ name: "router", available: true, dedicated: true }], makers: {}, updatedAt: "", source: "override",
      models: [{ id: "router/~typesafe/jev-latest", provider: "router", providerKind: "openrouter", family: "jev-latest",
        maker: "typesafe", displayName: "Jev Latest", type: "decision", selectionHidden: false, favorite: false,
        contextWindow: 32000, maxTokens: 0, pricing: { inputPer1M: 0.042, outputPer1M: 0 },
        capabilities: { tools: false, structuredOutput: false, imageInput: false, reasoning: false, decision: true } }],
      selections: { embedding: { model: "", source: "default" } },
      rerankerMinScore: { value: 0.01, source: "default" }, selectionAvailable: { embedding: false, rerank: false },
      catalogMinScore: { value: 0.01, source: "default" },
      unknownModelPolicy: { value: "refuse", source: "default" },
    } });
    if (path === "/api/models/decision") {
      const { model } = route.request().postDataJSON() as { model: string | null };
      saved.push(model);
      return route.fulfill({ json: { model } });
    }
    return route.abort();
  });
  await page.goto(`${base}/usage`);
  const picker = page.getByRole("combobox", { name: "Decision model for Agent suggestions" });
  await picker.click();
  await page.getByRole("option", { name: /Jev Latest/ }).click();
  await expect(picker).toHaveValue(/Jev Latest/);
  await page.getByRole("button", { name: "Clear decision model" }).click();
  expect(saved).toEqual(["router/~typesafe/jev-latest", null]);
});

test("reports unavailable Agent binding choices and reloads them on retry", async ({ page }) => {
  const reads = new Map<string, number>();
  for (const [path, ready] of [
    ["/api/mcps", [{ name: "tools", description: "Tool server" }]],
    ["/api/skills", [{ name: "review", description: "Review work" }]],
    ["/api/agents", [{ name: "helper", description: "Local helper", configured: true }]],
  ] as const) {
    await page.route(`**${path}`, route => {
      const count = (reads.get(path) ?? 0) + 1;
      reads.set(path, count);
      return count === 1
        ? route.fulfill({ status: 503, json: { error: "Temporary outage" } })
        : route.fulfill({ json: ready });
    });
  }
  await page.goto(`${base}/configuration`);
  await expect(page.getByRole("alert")).toContainText("MCP servers, Skills, Subagents");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect([...reads.values()]).toEqual([2, 2, 2]);
  await page.getByPlaceholder("Search registered skills").click();
  await expect(page.getByRole("option", { name: /review/ })).toBeVisible();
});
