import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { test, expect } from "@playwright/test";
import { createProviderModelDiscovery } from "../src/infrastructure/llm/providerModelDiscovery";
import type { DiscoveredModel, RegisteredModel } from "../src/domain/llm/providerModels";

let server: Server;
let base: string;
let discovered: DiscoveredModel[];
let selected: RegisteredModel[];
let saves: RegisteredModel[];
let blockDeletion: boolean;
let failDiscovery: boolean;
let discoveryQueries: string[];

test.beforeAll(async () => {
  discovered = await createProviderModelDiscovery(async () => Response.json({ data: [
    { id: "vendor/zeta", name: "Zeta", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      supported_parameters: ["tools", "reasoning", "structured_outputs"], context_length: 1000000,
      top_provider: { max_completion_tokens: 128000 }, pricing: { prompt: "0.00001", completion: "0.00002", input_cache_read: "0.000001" } },
    { id: "vendor/alpha", name: "Alpha", architecture: { output_modalities: ["text"] }, pricing: { prompt: "0.000002", completion: "0.000004" } },
    { id: "~typesafe/jev-latest", name: "TypeSafe: Jev Latest", architecture: { input_modalities: ["text"], output_modalities: ["decisions"] },
      supported_parameters: [], context_length: 32000, top_provider: { max_completion_tokens: 28800 }, pricing: { prompt: "0.000000042", completion: "0" } },
    { id: "constructor", name: "Unknown" },
  ] })).list({ name: "fixture", kind: "openrouter", baseUrl: "https://provider.test/v1", apiKey: "", auth: "bearer", keepModelPrefix: false });
  const bundle = await build({ entryPoints: ["browser-tests/fixtures/model-selection.tsx"], bundle: true, write: false,
    outdir: "/tmp/agent-studio-model-fixture", platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
  server = createServer((request, response) => {
    const file = bundle.outputFiles.find(file => request.url === `/${file.path.split("/").at(-1)}`);
    response.setHeader("Content-Type", `${file ? file.path.endsWith(".css") ? "text/css" : "text/javascript" : "text/html"}; charset=utf-8`);
    response.end(file?.contents ?? '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/model-selection.css"><div id="root"></div><script src="/model-selection.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
test.beforeEach(async ({ page }) => {
  selected = []; saves = []; blockDeletion = false; failDiscovery = false; discoveryQueries = [];
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/settings") return route.fulfill({ json: { llmProviders: { items: [{ name: "fixture", kind: "openrouter" }, { name: "other", kind: "openrouter" }] } } });
    if (path === "/api/models/discover") {
      discoveryQueries.push(new URL(route.request().url()).search);
      return failDiscovery ? route.fulfill({ status: 502, json: { error: "Provider discovery failed" } }) : route.fulfill({ json: { models: discovered } });
    }
    if (path === "/api/models/registry") {
      if (route.request().method() === "DELETE") {
        if (blockDeletion) return route.fulfill({ status: 409, json: { error: "Change model usage before deleting this model" } });
        const id = new URL(route.request().url()).searchParams.get("id");
        selected = selected.filter(model => model.id !== id);
        return route.fulfill({ status: 204 });
      }
      if (route.request().method() === "POST") {
        const model = route.request().postDataJSON() as RegisteredModel;
        saves.push(model); selected = [...selected.filter(item => item.id !== model.id), model];
      }
      return route.fulfill({ json: { models: selected } });
    }
    return route.abort();
  });
  await page.goto(base);
  await page.getByRole("button", { name: "Discover models", exact: true }).click();
  await expect(page.getByRole("article")).toHaveCount(4);
});

test("shows multiple capability badges, limits and prices and supports name/price sorting", async ({ page }) => {
  const zeta = page.getByRole("article").filter({ hasText: "Zeta" });
  for (const label of ["Text", "Tools", "Vision", "Reasoning", "Structured output", "Context 1M", "128K", "$10.00 in", "$20.00 out", "cached $1.00"]) await expect(zeta).toContainText(label);
  const cards = page.getByRole("article");
  await expect(cards.first()).toContainText("Alpha");
  await page.getByRole("button", { name: "Name ↑" }).click();
  await expect(cards.first()).toContainText("Zeta");
  await page.getByRole("button", { name: "Price", exact: true }).click();
  await expect(cards.first()).toContainText("Jev Latest");
  await expect(cards.last()).toContainText("Unknown");
  await page.getByRole("checkbox", { name: "Tools", exact: true }).check();
  await page.getByRole("checkbox", { name: "Vision", exact: true }).check();
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("Zeta");
});

test("adds Jev immediately without a dialog and retains decisions after reload and in selected models", async ({ page }) => {
  const jev = page.getByRole("article").filter({ hasText: "~typesafe/jev-latest" });
  await expect(jev).toContainText("Decisions");
  await expect(jev).toContainText("32K");
  await jev.getByRole("button", { name: "Add model" }).click();
  await expect(jev).toContainText("Selected");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(saves).toHaveLength(1);
  expect(saves[0]).toMatchObject({ id: "fixture/~typesafe/jev-latest", type: "decisions", contextWindow: 32000, maxTokens: 28800, outputModalities: ["decisions"], pricing: { inputPer1M: expect.closeTo(0.042), outputPer1M: 0 } });
  await page.reload();
  await page.getByRole("button", { name: "Discover models", exact: true }).click();
  await expect(jev).toContainText("Selected");
  await page.goto(`${base}/selected`);
  await expect(page.getByRole("article")).toHaveCount(1);
  await expect(page.getByRole("article")).toContainText("Decisions");
  await expect(page.getByRole("button", { name: "Add model" })).toHaveCount(0);
});

test("requires an inline type choice for missing metadata instead of defaulting to text", async ({ page }) => {
  const unknown = page.getByRole("article").filter({ hasText: "Unknown" });
  await expect(unknown.getByRole("button", { name: "Add model" })).toBeDisabled();
  await unknown.getByRole("combobox").click();
  await page.getByRole("option", { name: "Decisions", exact: true }).click();
  await unknown.getByRole("button", { name: "Add model" }).click();
  await expect(unknown).toContainText("Selected");
  await expect(unknown).toContainText("Decisions");
  expect(saves[0]?.type).toBe("decisions");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("shows saved selections before discovery and deletes from the selected-only view", async ({ page }) => {
  const jev = page.getByRole("article").filter({ hasText: "~typesafe/jev-latest" });
  await jev.getByRole("button", { name: "Add model" }).click();
  await expect(jev).toContainText("Selected");
  await page.getByRole("checkbox", { name: "Selected models only" }).check();
  await expect(page.getByRole("checkbox", { name: "Selected models only" })).toBeChecked();
  await expect(page.getByRole("article")).toHaveCount(1);
  await page.getByRole("checkbox", { name: "Selected models only" }).uncheck();
  await expect(page.getByRole("article")).toHaveCount(4);
  await page.reload();
  await expect(page.getByRole("article")).toHaveCount(1);
  await page.getByRole("checkbox", { name: "Selected models only" }).check();
  await jev.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("article")).toHaveCount(1);
  await jev.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("article")).toHaveCount(0);
  expect(selected).toEqual([]);
  await page.reload();
  await expect(page.getByRole("article")).toHaveCount(0);
});

test("retains the selected model and surfaces the API's in-use deletion refusal", async ({ page }) => {
  const jev = page.getByRole("article").filter({ hasText: "~typesafe/jev-latest" });
  await jev.getByRole("button", { name: "Add model" }).click();
  await expect(jev).toContainText("Selected");
  blockDeletion = true;
  await jev.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Change model usage before deleting this model");
  await expect(jev).toContainText("Selected");
  expect(selected).toHaveLength(1);
});

test("keeps model cards within a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("always queries the complete provider catalog even while selected-only is active", async ({ page }) => {
  const jev = page.getByRole("article").filter({ hasText: "~typesafe/jev-latest" });
  await jev.getByRole("button", { name: "Add model" }).click();
  await expect(jev).toContainText("Selected");
  await page.getByRole("checkbox", { name: "Selected models only" }).check();
  await page.getByRole("button", { name: "Discover models", exact: true }).click();
  await expect.poll(() => discoveryQueries.length).toBe(2);
  expect(discoveryQueries).toEqual(["?provider=fixture", "?provider=fixture"]);
  await expect(page.getByRole("article")).toHaveCount(1);
  await page.getByRole("checkbox", { name: "Selected models only" }).uncheck();
  await expect(page.getByRole("article")).toHaveCount(4);
  failDiscovery = true;
  await page.getByRole("checkbox", { name: "Selected models only" }).check();
  await page.getByRole("button", { name: "Discover models", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Provider discovery failed");
  await page.getByRole("checkbox", { name: "Selected models only" }).uncheck();
  await expect(page.getByRole("article")).toHaveCount(4);
});

test("restores provider, query, type, capability filters, selected-only and sort from browser storage", async ({ page }) => {
  await page.getByRole("combobox", { name: "Providers", exact: true }).click();
  await page.getByRole("option", { name: "other (openrouter)", exact: true }).click();
  await page.getByRole("button", { name: "Discover models", exact: true }).click();
  const zeta = page.getByRole("article").filter({ hasText: "Zeta" });
  await zeta.getByRole("button", { name: "Add model" }).click();
  await expect(zeta).toContainText("Selected");
  await page.getByRole("textbox", { name: "Search models" }).fill("Zeta");
  await page.getByRole("combobox", { name: "Model type", exact: true }).click();
  await page.getByRole("option", { name: "Text", exact: true }).click();
  await page.getByRole("checkbox", { name: "Tools", exact: true }).check();
  await page.getByRole("checkbox", { name: "Vision", exact: true }).check();
  await page.getByRole("checkbox", { name: "Selected models only" }).check();
  await page.getByRole("button", { name: "Price", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Providers", exact: true })).toHaveValue("other (openrouter)");
  await expect(page.getByRole("textbox", { name: "Search models" })).toHaveValue("Zeta");
  await expect(page.getByRole("combobox", { name: "Model type", exact: true })).toHaveValue("Text");
  for (const name of ["Tools", "Vision", "Selected models only"]) await expect(page.getByRole("checkbox", { name, exact: true })).toBeChecked();
  await expect(page.getByRole("button", { name: "Price ↑" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Discover models", exact: true }).click();
  await expect(zeta).toContainText("Selected");
  await page.getByRole("button", { name: "Reset filters" }).click();
  await expect(page.getByRole("article")).toHaveCount(4);
});

test("a removed provider preference cannot hide the remaining registered models", async ({ page }) => {
  await page.getByRole("article").filter({ hasText: "Zeta" }).getByRole("button", { name: "Add model" }).click();
  await expect.poll(() => selected.length).toBe(1);
  selected.push({ ...selected[0]!, id: "other/temporary", wireId: "temporary", provider: "other", displayName: "Temporary" });
  await page.goto(`${base}/selected`);
  await page.getByRole("combobox", { name: "Providers", exact: true }).click();
  await page.getByRole("option", { name: "other", exact: true }).click();
  await expect(page.getByRole("article")).toHaveCount(1);
  selected = selected.filter(model => model.provider !== "other");
  await page.reload();
  await expect(page.getByRole("article")).toHaveCount(1);
  await expect(page.getByRole("article")).toContainText("Zeta");
});

test("editing uses the registration rules without retaining obsolete output types", async ({ page }) => {
  await page.getByRole("article").filter({ hasText: "Zeta" }).getByRole("button", { name: "Add model" }).click();
  await expect.poll(() => selected.length).toBe(1);
  await page.goto(`${base}/registered`);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("dialog").getByRole("textbox", { name: "Name", exact: true }).fill("Edited model");
  await page.getByRole("dialog").getByRole("combobox", { name: "Model type", exact: true }).click();
  await page.getByRole("option", { name: "Embedding", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(selected[0]).toMatchObject({ id: "fixture/vendor/zeta", wireId: "vendor/zeta", displayName: "Edited model", type: "embedding", maxTokens: 0, pricing: { cachedInputPer1M: 1 } });
  expect(selected[0]?.outputModalities).toBeUndefined();
});
