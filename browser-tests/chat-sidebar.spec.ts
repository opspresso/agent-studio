import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { build, type Plugin } from "esbuild";
import { test, expect } from "@playwright/test";
import type { ChatListResponse } from "../src/app/api/chats/route";

let server: Server;
let base: string;

const nextStubs: Plugin = { name: "next-stubs", setup(build) {
  build.onResolve({ filter: /^next\/(link|navigation)$/ }, args => ({ path: args.path, namespace: "next-stubs" }));
  build.onLoad({ filter: /^next\/link$/, namespace: "next-stubs" }, () => ({
    contents: 'import React from "react"; export default function Link(props) { return React.createElement("a", props); }',
    loader: "js", resolveDir: process.cwd(),
  }));
  build.onLoad({ filter: /^next\/navigation$/, namespace: "next-stubs" }, () => ({
    contents: 'export const usePathname = () => window.location.pathname; export const useRouter = () => ({ push() {} });', loader: "js",
  }));
} };

test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["browser-tests/fixtures/chat-sidebar.tsx"], bundle: true, write: false,
    outdir: "/tmp/agent-studio-sidebar-fixture", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" }, plugins: [nextStubs] });
  server = createServer((request, response) => {
    const file = bundle.outputFiles.find(file => request.url === `/${file.path.split("/").at(-1)}`);
    response.setHeader("Content-Type", `${file ? file.path.endsWith(".css") ? "text/css" : "text/javascript" : "text/html"}; charset=utf-8`);
    response.end(file?.contents ?? '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/chat-sidebar.css"><div id="root"></div><script src="/chat-sidebar.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

test("separates chats and workspaces in a tab and restores the selected tab after reload", async ({ page }) => {
  const chats: ChatListResponse = { chats: [
    { chatId: "chat-1", ownerEmail: "reader@example.test", title: "General discussion", createdAt: "", updatedAt: "" },
    { chatId: "chat-2", ownerEmail: "reader@example.test", title: "Coding workspace", workspaceId: "workspace-1", createdAt: "", updatedAt: "" },
  ], hasMore: false };
  await page.route("**/api/chats?**", route => route.fulfill({ json: chats }));
  await page.goto(base);
  const sidebar = page.locator("aside");
  await expect(sidebar.getByRole("tab", { name: "Chats" })).toHaveAttribute("aria-selected", "true");
  await expect(sidebar.getByRole("link", { name: "General discussion" })).toBeVisible();
  await sidebar.getByRole("tab", { name: "Workspaces" }).click();
  await expect(sidebar.getByRole("link", { name: "Coding workspace" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "General discussion" })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("agent-studio-chat-sidebar-tab") ?? "null"))).toBe("workspaces");
  await page.reload();
  await expect(sidebar.getByRole("tab", { name: "Workspaces" })).toHaveAttribute("aria-selected", "true");
  await expect(sidebar.getByRole("link", { name: "Coding workspace" })).toBeVisible();
});

test("uses the same saved selection in the narrow history drawer", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 700 });
  await page.route("**/api/chats?**", route => route.fulfill({ json: { chats: [
    { chatId: "chat-2", ownerEmail: "reader@example.test", title: "Coding workspace", workspaceId: "workspace-1", createdAt: "", updatedAt: "" },
  ], hasMore: false } satisfies ChatListResponse }));
  await page.goto(base);
  await page.getByRole("button", { name: "Chats & Workspaces" }).click();
  const drawer = page.getByRole("dialog", { name: "Chats & Workspaces" });
  await drawer.getByRole("tab", { name: "Workspaces" }).click();
  await expect(drawer.getByRole("link", { name: "Coding workspace" })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Chats & Workspaces" }).click();
  await expect(page.getByRole("dialog", { name: "Chats & Workspaces" }).getByRole("tab", { name: "Workspaces" }))
    .toHaveAttribute("aria-selected", "true");
});

test("marks the open Chat or Workspace in the sidebar", async ({ page }) => {
  await page.route("**/api/chats?**", route => route.fulfill({ json: { chats: [
    { chatId: "chat-1", ownerEmail: "reader@example.test", title: "General discussion", createdAt: "", updatedAt: "" },
    { chatId: "chat-2", ownerEmail: "reader@example.test", title: "Coding workspace", workspaceId: "workspace-1", createdAt: "", updatedAt: "" },
  ], hasMore: false } satisfies ChatListResponse }));
  await page.goto(`${base}/chats/chat-1`);
  const sidebar = page.locator("aside");
  const chat = sidebar.getByRole("link", { name: "General discussion" });
  await expect(chat).toHaveAttribute("aria-current", "page");
  await expect(chat.locator("..")).toHaveAttribute("data-active", "true");
  expect(await chat.evaluate(element => getComputedStyle(element).fontWeight)).toBe("700");
  await expect(sidebar.getByRole("tab", { name: "Chats" })).toHaveAttribute("data-current", "true");
  await expect(sidebar.getByRole("tab", { name: "Chats" })).toHaveAttribute("title", "Open: General discussion");
  expect(await sidebar.getByRole("tab", { name: "Chats" }).evaluate(element => getComputedStyle(element, "::after").width)).toBe("6px");

  await sidebar.getByRole("tab", { name: "Workspaces" }).click();
  await expect(sidebar.getByRole("tab", { name: "Chats" })).toHaveAttribute("data-current", "true");
  await sidebar.getByRole("link", { name: "Coding workspace" }).click();
  const workspace = sidebar.getByRole("link", { name: "Coding workspace" });
  await expect(workspace).toHaveAttribute("aria-current", "page");
  await expect(workspace.locator("..")).toHaveAttribute("data-active", "true");
  await expect(sidebar.getByRole("tab", { name: "Workspaces" })).toHaveAttribute("data-current", "true");
  await expect(sidebar.getByRole("tab", { name: "Workspaces" })).toHaveAttribute("title", "Open: Coding workspace");
});
