import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { test, expect, type Page } from "@playwright/test";
import type { DiscoveredModel, RegisteredModel } from "../src/domain/llm/providerModels";

const modelRows = (page: Page) => page.getByRole("row").filter({ has: page.getByRole("cell") });

let server: Server;
let base: string;
let discovered: DiscoveredModel[];
let selected: RegisteredModel[];
let saves: RegisteredModel[];
let blockDeletion: boolean;
let failDiscovery: boolean;
let discoveryQueries: string[];
let favorites: string[];
let failFavorites: boolean;
let holdFirstFavoritePatch: boolean;
let releaseFirstFavoritePatch: (() => void) | undefined;
let favoritePatchCount: number;

test.beforeAll(async () => {
  discovered = [
    { id: "openrouter/zeta", wireId: "vendor/zeta", displayName: "Zeta", type: "text", inputModalities: ["text", "image"], outputModalities: ["text"],
      capabilities: { tools: true, imageInput: true, reasoning: true, structuredOutput: true },
      contextWindow: 1000000, maxTokens: 128000, pricing: { inputPer1M: 10, outputPer1M: 20, cachedInputPer1M: 1 } },
    { wireId: "vendor/alpha", displayName: "Alpha", type: "text", outputModalities: ["text"], pricing: { inputPer1M: 2, outputPer1M: 4 } },
    { wireId: "~typesafe/jev-latest", displayName: "TypeSafe: Jev Latest", type: "decision", inputModalities: ["text"],
      outputModalities: ["decision"], contextWindow: 32000, maxTokens: 28800,
      capabilities: { tools: false, imageInput: false, reasoning: false, structuredOutput: false }, pricing: { inputPer1M: 0.042, outputPer1M: 0 } },
    { wireId: "constructor", displayName: "Unknown" },
  ];
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
  discovered[0] = { ...discovered[0]!, pricing: { inputPer1M: 10, outputPer1M: 20, cachedInputPer1M: 1 } };
  selected = []; saves = []; blockDeletion = false; failDiscovery = false; failFavorites = false; discoveryQueries = []; favorites = [];
  holdFirstFavoritePatch = false; releaseFirstFavoritePatch = undefined; favoritePatchCount = 0;
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/settings") return route.fulfill({ json: { llmProviders: { items: [{ name: "fixture", kind: "openrouter" }, { name: "other", kind: "openrouter" }] } } });
    if (path === "/api/models/discover") {
      discoveryQueries.push(new URL(route.request().url()).search);
      return failDiscovery ? route.fulfill({ status: 502, json: { error: "Provider discovery failed" } }) : route.fulfill({ json: { models: discovered } });
    }
    if (path === "/api/models/favorites") {
      if (failFavorites && route.request().method() === "GET") return route.fulfill({ status: 503, json: { error: "Favorites unavailable" } });
      if (route.request().method() === "PATCH") {
        const { model, favorite } = route.request().postDataJSON() as { model: string; favorite: boolean };
        favorites = favorite ? [...new Set([...favorites, model])].sort() : favorites.filter(id => id !== model);
        const response = { models: [...favorites] };
        favoritePatchCount += 1;
        if (holdFirstFavoritePatch && favoritePatchCount === 1) {
          await new Promise<void>(resolve => { releaseFirstFavoritePatch = resolve; });
        }
        return route.fulfill({ json: response });
      }
      return route.fulfill({ json: { models: favorites } });
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
  await page.getByRole("button", { name: "Discover Models", exact: true }).click();
  await expect(modelRows(page)).toHaveCount(4);
});

test("shows multiple capability badges, limits and prices and supports name/price sorting", async ({ page }) => {
  const zeta = modelRows(page).filter({ hasText: "Zeta" });
  for (const label of ["Text", "Tools", "Vision", "Reasoning", "Structured output", "Context 1M", "128K", "$10.00 in", "$20.00 out", "cached $1.00"]) await expect(zeta).toContainText(label);
  const cards = modelRows(page);
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

test("updates a selected model's displayed rate after catalog rediscovery", async ({ page }) => {
  const zeta = modelRows(page).filter({ hasText: "Zeta" });
  await zeta.getByRole("button", { name: "Add model" }).click();
  await expect(zeta).toContainText("$10.00 in");
  discovered[0] = { ...discovered[0]!, pricing: { inputPer1M: 12, outputPer1M: 24 } };
  await page.getByRole("button", { name: "Discover Models", exact: true }).click();
  await expect(zeta).toContainText("$12.00 in");
});

test("finds a discovered model by its published ID", async ({ page }) => {
  await page.getByRole("textbox", { name: "Search models" }).fill("openrouter/zeta");
  await expect(modelRows(page)).toHaveCount(1);
  await expect(modelRows(page)).toContainText("Zeta");
});

test("adds Jev immediately without a dialog and retains decision type after reload", async ({ page }) => {
  const jev = modelRows(page).filter({ hasText: "~typesafe/jev-latest" });
  await expect(jev).toContainText("Decision");
  await expect(jev).toContainText("32K");
  await jev.getByRole("button", { name: "Add model" }).click();
  await expect(jev).toContainText("Selected");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(saves).toHaveLength(1);
  expect(saves[0]).toMatchObject({ id: "fixture/~typesafe/jev-latest", type: "decision", contextWindow: 32000, maxTokens: 28800, outputModalities: ["decision"], pricing: { inputPer1M: expect.closeTo(0.042), outputPer1M: 0 } });
  await page.reload();
  await page.getByRole("button", { name: "Discover Models", exact: true }).click();
  await expect(jev).toContainText("Selected");
  await page.goto(`${base}/selected`);
  await expect(modelRows(page)).toHaveCount(1);
  await expect(modelRows(page)).toContainText("Decision");
  await expect(page.getByRole("button", { name: "Add model" })).toHaveCount(0);
});

test("requires an inline type choice for missing metadata instead of defaulting to text", async ({ page }) => {
  const unknown = modelRows(page).filter({ hasText: "Unknown" });
  await expect(unknown.getByRole("button", { name: "Add model" })).toBeDisabled();
  await unknown.getByRole("combobox").click();
  await page.getByRole("option", { name: "Decision", exact: true }).click();
  await unknown.getByRole("button", { name: "Add model" }).click();
  await expect(unknown).toContainText("Selected");
  await expect(unknown).toContainText("Decision");
  expect(saves[0]?.type).toBe("decision");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("shows saved selections before discovery and deletes from the selected-only view", async ({ page }) => {
  const jev = modelRows(page).filter({ hasText: "~typesafe/jev-latest" });
  await jev.getByRole("button", { name: "Add model" }).click();
  await expect(jev).toContainText("Selected");
  await page.getByRole("checkbox", { name: "Selected Models only" }).check();
  await expect(page.getByRole("checkbox", { name: "Selected Models only" })).toBeChecked();
  await expect(modelRows(page)).toHaveCount(1);
  await page.getByRole("checkbox", { name: "Selected Models only" }).uncheck();
  await expect(modelRows(page)).toHaveCount(4);
  await page.reload();
  await expect(modelRows(page)).toHaveCount(1);
  await page.getByRole("checkbox", { name: "Selected Models only" }).check();
  await jev.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await expect(modelRows(page)).toHaveCount(1);
  await jev.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(modelRows(page)).toHaveCount(0);
  expect(selected).toEqual([]);
  await page.reload();
  await expect(modelRows(page)).toHaveCount(0);
});

test("saves personal favorites from selected models and restores them after reload", async ({ page }) => {
  const jev = modelRows(page).filter({ hasText: "~typesafe/jev-latest" });
  await jev.getByRole("button", { name: "Add model" }).click();
  await page.goto(`${base}/selected`);
  const selectedCard = modelRows(page).filter({ hasText: "fixture/~typesafe/jev-latest" });
  await page.getByRole("textbox", { name: "Search models" }).fill("fixture/~typesafe/jev-latest");
  await expect(modelRows(page)).toHaveCount(1);
  const identity = selectedCard.getByRole("cell").first();
  const addFavorite = identity.getByRole("button", { name: "Add to favorites" });
  await expect(addFavorite).toHaveText("");
  await addFavorite.click();
  const removeFavorite = identity.getByRole("button", { name: "Remove from favorites" });
  await expect(removeFavorite).toHaveAttribute("aria-pressed", "true");
  await expect(removeFavorite).toHaveText("");
  expect(favorites).toEqual(["fixture/~typesafe/jev-latest"]);
  await page.reload();
  await expect(identity.getByRole("button", { name: "Remove from favorites" })).toBeVisible();
  await identity.getByRole("button", { name: "Remove from favorites" }).click();
  expect(favorites).toEqual([]);
});

test("keeps other stars active and preserves distinct favorites when responses arrive out of order", async ({ page }) => {
  await modelRows(page).filter({ hasText: "openrouter/zeta" }).getByRole("button", { name: "Add model" }).click();
  await modelRows(page).filter({ hasText: "~typesafe/jev-latest" }).getByRole("button", { name: "Add model" }).click();
  await page.goto(`${base}/selected`);
  const zeta = modelRows(page).filter({ hasText: "openrouter/zeta" }).getByRole("cell").first();
  const jev = modelRows(page).filter({ hasText: "fixture/~typesafe/jev-latest" }).getByRole("cell").first();
  holdFirstFavoritePatch = true;
  await zeta.getByRole("button", { name: "Add to favorites" }).click();
  await expect.poll(() => Boolean(releaseFirstFavoritePatch)).toBe(true);
  await expect(zeta.getByRole("button", { name: "Add to favorites" })).toBeDisabled();
  await expect(jev.getByRole("button", { name: "Add to favorites" })).toBeEnabled();
  await jev.getByRole("button", { name: "Add to favorites" }).click();
  await expect(jev.getByRole("button", { name: "Remove from favorites" })).toBeVisible();
  releaseFirstFavoritePatch?.();
  await expect(zeta.getByRole("button", { name: "Remove from favorites" })).toBeVisible();
  await expect(jev.getByRole("button", { name: "Remove from favorites" })).toBeVisible();
  expect(favorites).toEqual(["fixture/~typesafe/jev-latest", "openrouter/zeta"]);
});

test("keeps registered models visible when favorites cannot be loaded", async ({ page }) => {
  const jev = modelRows(page).filter({ hasText: "~typesafe/jev-latest" });
  await jev.getByRole("button", { name: "Add model" }).click();
  failFavorites = true;
  await page.goto(`${base}/selected`);
  await expect(modelRows(page)).toContainText("Jev Latest");
  await expect(page.getByRole("alert")).toContainText("Favorites unavailable");
  await expect(page.getByRole("button", { name: "Add to favorites" })).toHaveCount(0);
});

test("retains the selected model and surfaces the API's in-use deletion refusal", async ({ page }) => {
  const jev = modelRows(page).filter({ hasText: "~typesafe/jev-latest" });
  await jev.getByRole("button", { name: "Add model" }).click();
  await expect(jev).toContainText("Selected");
  blockDeletion = true;
  await jev.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Change model usage before deleting this model");
  await expect(jev).toContainText("Selected");
  expect(selected).toHaveLength(1);
});

test("keeps model rows within a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("uses the saved catalog view on the first client mount", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("agent-studio-catalog-view", '"grid"'));
  await page.goto(`${base}/view`);
  await expect(page.getByLabel("First catalog view")).toHaveText("grid");
});

test("fits model rows to their content container on a wide viewport", async ({ page }) => {
  await page.goto(`${base}/narrow`);
  await page.getByRole("button", { name: "Discover Models", exact: true }).click();
  await expect(modelRows(page)).toHaveCount(4);
  expect(await page.getByRole("table", { name: "Models" }).evaluate(element =>
    element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("remembers row or grid view and fits at most four models across", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.getByText("Grid", { exact: true }).click();
  await expect(page.getByRole("radio", { name: "Grid" })).toBeChecked();
  const desktop = await modelRows(page).evaluateAll(elements => elements.map(element => {
    const box = element.getBoundingClientRect();
    return { x: box.x, y: box.y };
  }));
  expect(desktop).toHaveLength(4);
  expect(new Set(desktop.map(box => Math.round(box.y))).size).toBe(1);
  expect(desktop.map(box => box.x)).toEqual([...desktop.map(box => box.x)].sort((a, b) => a - b));

  await page.reload();
  await expect(page.getByRole("radio", { name: "Grid" })).toBeChecked();
  await page.goto(`${base}/selected`);
  await expect(page.getByRole("radio", { name: "Grid" })).toBeChecked();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base);
  await page.getByRole("button", { name: "Discover Models", exact: true }).click();
  await expect(modelRows(page)).toHaveCount(4);
  const mobile = await modelRows(page).evaluateAll(elements => elements.map(element => element.getBoundingClientRect().y));
  expect(new Set(mobile.map(y => Math.round(y))).size).toBe(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.getByText("Rows", { exact: true }).click();
  await page.reload();
  await expect(page.getByRole("radio", { name: "Rows" })).toBeChecked();
});

test("shared model picker shows the selected identity, favorite group and per-model prices on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/picker`);
  const picker = page.getByRole("combobox", { name: "Model" });
  await expect(picker).toHaveValue("Office model (office/long-model-name-with-many-segments-and-a-provider-route)");
  await expect(page.getByText("office · $2.00 in · $8.00 out per 1M")).toBeVisible();
  await picker.click();
  await expect(page.getByText("Favorites", { exact: true })).toBeVisible();
  const favorite = page.getByRole("option", { name: /Jev Latest/ });
  await expect(favorite).toContainText("router/vendor/jev-latest");
  await expect(favorite).toContainText("$0.042 in");
  const longOption = page.getByRole("option", { name: /Office model/ });
  expect(await longOption.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await favorite.click();
  await expect(picker).toHaveValue("Jev Latest (router/vendor/jev-latest)");
  await expect(page.getByText("router · $0.042 in · $0.00 out per 1M")).toBeVisible();
});

test("always queries the complete provider catalog even while selected-only is active", async ({ page }) => {
  const jev = modelRows(page).filter({ hasText: "~typesafe/jev-latest" });
  await jev.getByRole("button", { name: "Add model" }).click();
  await expect(jev).toContainText("Selected");
  await page.getByRole("checkbox", { name: "Selected Models only" }).check();
  await page.getByRole("button", { name: "Discover Models", exact: true }).click();
  await expect.poll(() => discoveryQueries.length).toBe(2);
  expect(discoveryQueries).toEqual(["?provider=fixture", "?provider=fixture"]);
  await expect(modelRows(page)).toHaveCount(1);
  await page.getByRole("checkbox", { name: "Selected Models only" }).uncheck();
  await expect(modelRows(page)).toHaveCount(4);
  failDiscovery = true;
  await page.getByRole("checkbox", { name: "Selected Models only" }).check();
  await page.getByRole("button", { name: "Discover Models", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Provider discovery failed");
  await page.getByRole("checkbox", { name: "Selected Models only" }).uncheck();
  await expect(modelRows(page)).toHaveCount(4);
});

test("restores provider, query, type, capability filters, selected-only and sort from browser storage", async ({ page }) => {
  await page.getByRole("combobox", { name: "Providers", exact: true }).click();
  await page.getByRole("option", { name: "other (openrouter)", exact: true }).click();
  await page.getByRole("button", { name: "Discover Models", exact: true }).click();
  const zeta = modelRows(page).filter({ hasText: "Zeta" });
  await zeta.getByRole("button", { name: "Add model" }).click();
  await expect(zeta).toContainText("Selected");
  await page.getByRole("textbox", { name: "Search models" }).fill("Zeta");
  await page.getByRole("combobox", { name: "Model type", exact: true }).click();
  await page.getByRole("option", { name: "Text", exact: true }).click();
  await page.getByRole("checkbox", { name: "Tools", exact: true }).check();
  await page.getByRole("checkbox", { name: "Vision", exact: true }).check();
  await page.getByRole("checkbox", { name: "Selected Models only" }).check();
  await page.getByRole("button", { name: "Price", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Providers", exact: true })).toHaveValue("other (openrouter)");
  await expect(page.getByRole("textbox", { name: "Search models" })).toHaveValue("Zeta");
  await expect(page.getByRole("combobox", { name: "Model type", exact: true })).toHaveValue("Text");
  for (const name of ["Tools", "Vision", "Selected Models only"]) await expect(page.getByRole("checkbox", { name, exact: true })).toBeChecked();
  await expect(page.getByRole("button", { name: "Price ↑" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Discover Models", exact: true }).click();
  await expect(zeta).toContainText("Selected");
  await page.getByRole("button", { name: "Reset filters" }).click();
  await expect(modelRows(page)).toHaveCount(4);
});

test("a removed provider preference cannot hide the remaining registered models", async ({ page }) => {
  await modelRows(page).filter({ hasText: "Zeta" }).getByRole("button", { name: "Add model" }).click();
  await expect.poll(() => selected.length).toBe(1);
  selected.push({ ...selected[0]!, id: "other/temporary", wireId: "temporary", provider: "other", displayName: "Temporary" });
  await page.goto(`${base}/selected`);
  await page.getByRole("combobox", { name: "Providers", exact: true }).click();
  await page.getByRole("option", { name: "other", exact: true }).click();
  await expect(modelRows(page)).toHaveCount(1);
  selected = selected.filter(model => model.provider !== "other");
  await page.reload();
  await expect(modelRows(page)).toHaveCount(1);
  await expect(modelRows(page)).toContainText("Zeta");
});

test("editing uses the registration rules without retaining obsolete output types", async ({ page }) => {
  await modelRows(page).filter({ hasText: "Zeta" }).getByRole("button", { name: "Add model" }).click();
  await expect.poll(() => selected.length).toBe(1);
  await page.goto(`${base}/registered`);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("dialog").getByRole("textbox", { name: "Name", exact: true }).fill("Edited model");
  await page.getByRole("dialog").getByRole("combobox", { name: "Model type", exact: true }).click();
  await page.getByRole("option", { name: "Embedding", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(selected[0]).toMatchObject({ id: "openrouter/zeta", wireId: "vendor/zeta", displayName: "Edited model", type: "embedding", maxTokens: 0, pricing: { cachedInputPer1M: 1 } });
  expect(selected[0]?.outputModalities).toBeUndefined();
});
