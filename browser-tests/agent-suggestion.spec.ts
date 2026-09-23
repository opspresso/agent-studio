import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { test, expect } from "@playwright/test";

let server: Server;
let base: string;

test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["browser-tests/fixtures/agent-suggestion.tsx"], bundle: true, write: false,
    outdir: "/tmp/agent-studio-suggestion-fixture", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' } });
  server = createServer((request, response) => {
    const file = bundle.outputFiles.find(file => request.url === `/${file.path.split("/").at(-1)}`);
    response.setHeader("Content-Type", `${file ? file.path.endsWith(".css") ? "text/css" : "text/javascript" : "text/html"}; charset=utf-8`);
    response.end(file?.contents ?? '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/agent-suggestion.css"><div id="root"></div><script src="/agent-suggestion.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

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
        maker: "typesafe", displayName: "Jev Latest", type: "decisions", selectionHidden: false, favorite: false,
        contextWindow: 32000, maxTokens: 0, pricing: { inputPer1M: 0.042, outputPer1M: 0 },
        capabilities: { tools: false, structuredOutput: false, imageInput: false, reasoning: false, decisions: true } }],
      selections: { embedding: { model: "", source: "default" } },
      rerankerMinScore: { value: 0.01, source: "default" }, selectionAvailable: { embedding: false, rerank: false },
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
