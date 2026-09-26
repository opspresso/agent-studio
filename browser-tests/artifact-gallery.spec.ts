import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { test, expect } from "@playwright/test";
import type { ArtifactView } from "../src/app/artifacts/api";

let server: Server;
let base: string;
let artifacts: ArtifactView[];
let reads: string[];
let deletions: string[];
let errors: string[];

const image = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='180'%3E%3Crect width='240' height='180' fill='%23bed9dc'/%3E%3C/svg%3E";

test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["browser-tests/fixtures/artifact-gallery.tsx"], bundle: true, write: false,
    outdir: "/tmp/agent-studio-artifact-fixture", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" } });
  server = createServer(async (request, response) => {
    if (request.url?.startsWith("/icons/file-types/")) {
      const name = request.url.split("/").at(-1)!;
      response.setHeader("Content-Type", "image/svg+xml");
      response.end(await readFile(`public/icons/file-types/${name}`));
      return;
    }
    const file = bundle.outputFiles.find(file => request.url === `/${file.path.split("/").at(-1)}`);
    response.setHeader("Content-Type", `${file ? file.path.endsWith(".css") ? "text/css" : "text/javascript" : "text/html"}; charset=utf-8`);
    response.end(file?.contents ?? '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/artifact-gallery.css"><div id="root"></div><script src="/artifact-gallery.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
test.beforeEach(async ({ page }) => {
  artifacts = Array.from({ length: 6 }, (_, index) => ({
    artifactId: `file-${index}`, key: `artifacts/file-${index}`, source: index === 1 ? "attachment" : "generated",
    kind: index === 0 ? "image" : index === 2 ? "audio" : "document",
    filename: index === 0 ? "cover.png" : index === 1 ? "report.html" : index === 2 ? "recording.mp3" : `notes-${index}.pdf`,
    mimeType: index === 0 ? "image/png" : index === 1 ? "text/html" : index === 2 ? "audio/mpeg" : "application/pdf",
    byteSize: 1024, createdAt: "2026-09-26T00:00:00Z", agentName: "helper",
    producedBy: "writer", model: "office/model", prompt: "Quarterly report",
    ...(index === 5 ? {} : { url: index === 0 ? image : `/download/file-${index}` }),
  }));
  reads = []; deletions = []; errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", route => {
    const url = new URL(route.request().url());
    if (route.request().method() === "DELETE") {
      deletions.push(url.pathname);
      return route.fulfill({ status: 204 });
    }
    reads.push(url.pathname + url.search);
    const kind = url.searchParams.get("kind");
    return route.fulfill({ json: { artifacts: kind ? artifacts.filter(artifact => artifact.kind === kind) : artifacts } });
  });
});
test.afterEach(() => { expect(errors).toEqual([]); });

test("shows compact rows and preserves preview, download, provenance and unavailable states", async ({ page }) => {
  await page.goto(base);
  await expect(page.getByRole("article")).toHaveCount(6);
  await expect(page.getByRole("radio", { name: "Rows" })).toBeChecked();
  const cover = page.getByRole("article", { name: "cover.png" });
  const preview = cover.getByRole("button", { name: "View", exact: true }).first();
  expect((await preview.boundingBox())!.height).toBe(64);
  await preview.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog").getByRole("img", { name: "Quarterly report" })).toHaveAttribute("src", image);
  await page.getByRole("button", { name: "Show details", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("cover.png");
  await page.keyboard.press("Escape");
  const report = page.getByRole("article", { name: "report.html" });
  await expect(report).toContainText("helper");
  await expect(report).toContainText("office/model");
  await expect(report.getByRole("link", { name: "View", exact: true })).toHaveAttribute("href", "/api/artifacts/file-1/view");
  await expect(report.getByRole("link", { name: "Download", exact: true })).toHaveAttribute("href", "/download/file-1");
  const unavailable = page.getByRole("article", { name: "notes-5.pdf" });
  await expect(unavailable).toContainText("No longer available");
  await expect(unavailable.getByRole("link")).toHaveCount(0);
});

test("shares the saved icon view across galleries and fits one to four columns", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(base);
  const grid = page.getByRole("radio", { name: "Grid" });
  await grid.locator("..").click();
  await expect(grid).toBeChecked();
  await expect(grid.locator("..").locator("svg")).toHaveCount(1);
  expect((await page.getByRole("article", { name: "cover.png" }).getByRole("button", { name: "View", exact: true }).first().boundingBox())!.height).toBe(180);
  for (const [width, columns] of [[2400, 4], [1600, 4], [1050, 3], [720, 2], [390, 1]]) {
    await page.setViewportSize({ width: width!, height: 900 });
    await expect.poll(async () => page.getByRole("article").evaluateAll(entries => {
      const firstY = entries[0]!.getBoundingClientRect().y;
      return entries.filter(entry => Math.abs(entry.getBoundingClientRect().y - firstY) < 1).length;
    })).toBe(columns);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.reload();
  await expect(grid).toBeChecked();
  await page.goto(`${base}/agent`);
  await expect(grid).toBeChecked();
  await expect(page.getByRole("article")).toHaveCount(6);
  await expect(page.getByRole("article", { name: "cover.png" })).not.toContainText("helper");
  await page.getByRole("radio", { name: "Rows" }).locator("..").click();
  await page.goto(base);
  await expect(page.getByRole("radio", { name: "Rows" })).toBeChecked();
});

test("filters files and keeps confirmed deletion working in either view", async ({ page }) => {
  await page.goto(base);
  await page.getByRole("textbox", { name: "Filter…" }).fill("report.html");
  await expect(page.getByRole("article")).toHaveCount(1);
  await page.getByRole("radio", { name: "Grid" }).locator("..").click();
  await expect(page.getByRole("article")).toHaveCount(1);
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Delete Artifact");
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("article")).toHaveCount(0);
  expect(deletions).toEqual(["/api/artifacts/file-1"]);
  await page.getByRole("textbox", { name: "Filter…" }).clear();
  await page.getByText("Images", { exact: true }).click();
  await expect(page.getByRole("article")).toHaveCount(1);
  expect(reads.at(-1)).toBe("/api/artifacts?kind=image");
});
