import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { test, expect } from "@playwright/test";

let server: Server;
let base: string;

test.beforeAll(async () => {
  const bundle = await build({
    entryPoints: ["browser-tests/fixtures/playground.tsx"], bundle: true, write: false,
    outdir: "/tmp/agent-studio-playground-fixture", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
    plugins: [{ name: "next-navigation", setup(build) {
      build.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "next-stub" }));
      build.onLoad({ filter: /.*/, namespace: "next-stub" }, () => ({
        contents: 'export const usePathname = () => location.pathname;', loader: "js",
      }));
    } }],
  });
  server = createServer((request, response) => {
    const file = bundle.outputFiles.find(file => request.url === `/${file.path.split("/").at(-1)}`);
    response.setHeader("Content-Type", `${file ? file.path.endsWith(".css") ? "text/css" : "text/javascript" : "text/html"}; charset=utf-8`);
    response.end(file?.contents ?? '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/playground.css"><div id="root"></div><script src="/playground.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

for (const width of [1200, 390]) {
  test(`renders streamed Markdown and safe links at ${width}px`, async ({ page }, testInfo) => {
    page.on("pageerror", error => { throw error; });
    await page.setViewportSize({ width, height: 900 });
    const content = "# Result\n\n**Verified**\n\n| Item | Value |\n|---|---:|\n| Total | 300 |\n\n```python\n" + "assert total == 300 # " + "x".repeat(180) + "\n```\n\n[Workspace](/chats/ws-fixture)\n\n[Unsafe](javascript:alert(1))\n\n<script>alert(1)</script>";
    await page.route("**/api/agents/fixture/agent", route => route.fulfill({
      contentType: "text/event-stream",
      body: `data: ${JSON.stringify({ delta: { content: content.slice(0, 24) } })}\n\ndata: ${JSON.stringify({ delta: { content: content.slice(24) } })}\n\ndata: [DONE]\n\n`,
    }));
    await page.goto(base);
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Run the fixture");
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Result" })).toBeVisible();
    await expect(page.locator("strong")).toHaveText("Verified");
    await expect(page.getByRole("cell", { name: "300", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Workspace" })).toHaveAttribute("href", "/chats/ws-fixture");
    await expect(page.getByText("Unsafe", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Unsafe", exact: true })).toHaveCount(0);
    await expect(page.locator("main script")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
    const geometry = await page.locator("pre").evaluate(element => ({
      overflow: getComputedStyle(element).overflow,
      overflowY: getComputedStyle(element).overflowY,
      pageWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }));
    expect(geometry.overflowY).toBe("hidden");
    expect(geometry.overflow).not.toBe("auto");
    expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewportWidth);
    await page.screenshot({ path: testInfo.outputPath(`playground-${width}.png`), fullPage: true });
  });
}
