import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { test, expect, type Page } from "@playwright/test";
import { MAX_IMAGES_PER_TURN } from "../src/domain/llm/imageLimits";
import { MAX_DOCUMENTS } from "../src/domain/llm/documentLimits";

let server: Server;
let base: string;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const images = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => ({ name: `${prefix}-${index}.png`, mimeType: "image/png", buffer: png }));
const documents = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => ({ name: `${prefix}-${index}.txt`, mimeType: "text/plain", buffer: Buffer.from("document") }));

async function ready(page: Page, imageCount: number, documentCount: number) {
  await expect(page.getByLabel("Read state", { exact: true })).toHaveText("Ready");
  await expect(page.getByLabel("Attachment counts", { exact: true })).toHaveText(`${imageCount} images, ${documentCount} documents`);
}
async function pending(page: Page, name: string) {
  await expect.poll(() => page.evaluate(() => window.attachmentReads.pending)).toContain(name);
}
async function transfer(page: Page, gesture: "paste" | "drop", prefix: string, kind: "image" | "document", count: number) {
  await page.evaluate(({ gesture, prefix, kind, count }) => {
    const data = new DataTransfer();
    for (let index = 0; index < count; index += 1) data.items.add(new File(["bytes"], `${prefix}-${index}.${kind === "image" ? "png" : "txt"}`, { type: kind === "image" ? "image/png" : "text/plain" }));
    const event = gesture === "paste"
      ? new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })
      : new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true });
    document.querySelector(gesture === "paste" ? "textarea" : '[role="region"]')!.dispatchEvent(event);
  }, { gesture, prefix, kind, count });
}

test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["browser-tests/fixtures/attachments.tsx"], bundle: true, write: false,
    outdir: "/tmp/agent-studio-attachments-fixture", platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
  server = createServer((request, response) => {
    const file = bundle.outputFiles.find(file => request.url === `/${file.path.split("/").at(-1)}`);
    response.setHeader("Content-Type", `${file ? file.path.endsWith(".css") ? "text/css" : "text/javascript" : "text/html"}; charset=utf-8`);
    response.end(file?.contents ?? '<link rel="stylesheet" href="/attachments.css"><div id="root"></div><script src="/attachments.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
test.beforeEach(async ({ page }) => { await page.goto(base); await ready(page, 0, 0); });

test("never reads excess files from a large mixed selection", async ({ page }) => {
  await page.locator('input[type="file"]').setInputFiles([...images("image", 20), ...documents("document", 20)]);
  await ready(page, MAX_IMAGES_PER_TURN, MAX_DOCUMENTS);
  expect(await page.evaluate(() => window.attachmentReads.calls)).toEqual([
    ...images("image", MAX_IMAGES_PER_TURN).map(file => file.name), ...documents("document", MAX_DOCUMENTS).map(file => file.name),
  ]);
  await expect(page.getByText(`At most ${MAX_IMAGES_PER_TURN} images per message`, { exact: false })).toBeVisible();
  await expect(page.getByText(`At most ${MAX_DOCUMENTS} documents per message`, { exact: false })).toBeVisible();
  await expect(page.getByRole("img", { name: /^image-/ })).toHaveCount(MAX_IMAGES_PER_TURN);
  await expect(page.getByRole("button", { name: /^Remove document-/ })).toHaveCount(MAX_DOCUMENTS);
});

test("shares reservations across picker, paste and drop while reads overlap", async ({ page }) => {
  await page.evaluate(() => { window.attachmentReads.automatic = false; });
  await page.locator('input[type="file"]').setInputFiles(images("picker", 8));
  await pending(page, "picker-0.png");
  await transfer(page, "paste", "paste", "image", 8);
  await pending(page, "paste-0.png");
  await transfer(page, "drop", "drop", "document", 8);
  await pending(page, "drop-0.txt");
  await page.evaluate(() => window.attachmentReads.finishAll());
  await ready(page, MAX_IMAGES_PER_TURN, MAX_DOCUMENTS);
  const reads = await page.evaluate(() => window.attachmentReads.calls);
  expect(reads.filter(name => name.endsWith(".png"))).toHaveLength(MAX_IMAGES_PER_TURN);
  expect(reads.filter(name => name.endsWith(".txt"))).toHaveLength(MAX_DOCUMENTS);
  await expect(page.getByText(`At most ${MAX_IMAGES_PER_TURN} images per message`, { exact: false })).toBeVisible();
  await expect(page.getByText(`At most ${MAX_DOCUMENTS} documents per message`, { exact: false })).toBeVisible();
});

test("releases a failed read's reservation and keeps its error visible", async ({ page }) => {
  await page.evaluate(() => { window.attachmentReads.automatic = false; });
  await page.locator('input[type="file"]').setInputFiles(images("failure", MAX_IMAGES_PER_TURN + 1));
  await pending(page, "failure-0.png");
  await page.evaluate(() => { window.attachmentReads.automatic = true; window.attachmentReads.finish("failure-0.png", "error"); });
  await ready(page, MAX_IMAGES_PER_TURN, 0);
  expect(await page.evaluate(() => window.attachmentReads.calls)).toHaveLength(MAX_IMAGES_PER_TURN + 1);
  await expect(page.getByText("failure-0.png: could not be read", { exact: false })).toBeVisible();
  await expect(page.getByRole("img", { name: "failure-0.png", exact: true })).toHaveCount(0);
});

test("settles cancelled reads and makes their slots available again", async ({ page }) => {
  await page.evaluate(() => { window.attachmentReads.automatic = false; });
  await page.locator('input[type="file"]').setInputFiles(documents("cancelled", 1));
  await pending(page, "cancelled-0.txt");
  await page.evaluate(() => window.attachmentReads.finish("cancelled-0.txt", "abort"));
  await ready(page, 0, 0);
  await expect(page.getByText("cancelled-0.txt: reading was cancelled", { exact: false })).toBeVisible();
  await page.evaluate(() => { window.attachmentReads.automatic = true; });
  await page.locator('input[type="file"]').setInputFiles(documents("retry", MAX_DOCUMENTS));
  await ready(page, 0, MAX_DOCUMENTS);
  expect(await page.evaluate(() => window.attachmentReads.calls)).toHaveLength(MAX_DOCUMENTS + 1);
});

test("clear cancels old reads without continuing the old batch or changing the new draft", async ({ page }) => {
  await page.evaluate(() => { window.attachmentReads.automatic = false; });
  await page.locator('input[type="file"]').setInputFiles([...images("old", 3), ...documents("old", 3)]);
  await pending(page, "old-0.png");
  await page.getByRole("button", { name: "Clear attachments", exact: true }).click();
  await ready(page, 0, 0);
  await page.locator('input[type="file"]').setInputFiles(images("fresh", MAX_IMAGES_PER_TURN));
  await pending(page, "fresh-0.png");
  await page.evaluate(() => window.attachmentReads.finish("old-0.png", "error"));
  await expect(page.getByLabel("Read state", { exact: true })).toHaveText("Reading");
  await page.evaluate(() => window.attachmentReads.finishAll());
  await ready(page, MAX_IMAGES_PER_TURN, 0);
  expect(await page.evaluate(() => window.attachmentReads.calls)).toEqual(["old-0.png", ...images("fresh", MAX_IMAGES_PER_TURN).map(file => file.name)]);
  expect(await page.evaluate(() => window.attachmentReads.aborts)).toEqual(["old-0.png"]);
  await expect(page.getByText("old-0.png: could not be read", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Remove old-/ })).toHaveCount(0);
});

test("removal frees only the removed slots while another batch is reading", async ({ page }) => {
  await page.locator('input[type="file"]').setInputFiles([...images("staged", MAX_IMAGES_PER_TURN - 1), ...documents("staged", MAX_DOCUMENTS - 1)]);
  await ready(page, MAX_IMAGES_PER_TURN - 1, MAX_DOCUMENTS - 1);
  await page.evaluate(() => { window.attachmentReads.automatic = false; });
  await page.locator('input[type="file"]').setInputFiles(images("pending", 1));
  await pending(page, "pending-0.png");
  await page.locator('input[type="file"]').setInputFiles(documents("pending", 1));
  await pending(page, "pending-0.txt");
  await page.getByRole("button", { name: "Remove staged-0.png", exact: true }).click();
  await page.getByRole("button", { name: "Remove staged-0.txt", exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles(images("replacement", 1));
  await pending(page, "replacement-0.png");
  await page.locator('input[type="file"]').setInputFiles(documents("replacement", 1));
  await pending(page, "replacement-0.txt");
  await page.locator('input[type="file"]').setInputFiles([...images("excess", 1), ...documents("excess", 1)]);
  await page.evaluate(() => window.attachmentReads.finishAll());
  await ready(page, MAX_IMAGES_PER_TURN, MAX_DOCUMENTS);
  expect(await page.evaluate(() => window.attachmentReads.calls.filter(name => name.startsWith("excess-")))).toEqual([]);
  expect(await page.evaluate(() => window.attachmentReads.calls)).toHaveLength(MAX_IMAGES_PER_TURN + MAX_DOCUMENTS + 2);
  await expect(page.getByRole("button", { name: /^Remove staged-0\./ })).toHaveCount(0);
});

test("unmount cancels the current read and does not read the remaining files", async ({ page }) => {
  await page.evaluate(() => { window.attachmentReads.automatic = false; });
  await page.locator('input[type="file"]').setInputFiles(documents("unmounted", 3));
  await pending(page, "unmounted-0.txt");
  await page.getByRole("button", { name: "Hide composer", exact: true }).click();
  await page.evaluate(() => window.attachmentReads.finishAll());
  await page.getByRole("button", { name: "Show composer", exact: true }).click();
  await ready(page, 0, 0);
  expect(await page.evaluate(() => window.attachmentReads.calls)).toEqual(["unmounted-0.txt"]);
  expect(await page.evaluate(() => window.attachmentReads.aborts)).toEqual(["unmounted-0.txt"]);
});
