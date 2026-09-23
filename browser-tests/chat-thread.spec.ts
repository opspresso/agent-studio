import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { test, expect, type Route } from "@playwright/test";
import type { ChatWithMessages } from "../src/application/chat/getChat";

let server: Server;
let base: string;
let pageErrors: string[];

const CHAT = {
  chatId: "chat-1", title: "Conversation", ownerEmail: "reader@example.test",
  createdAt: "2026-09-21T00:00:00Z", updatedAt: "2026-09-21T00:00:00Z",
};
const THREAD: ChatWithMessages = {
  chat: CHAT,
  messages: [{ chatId: CHAT.chatId, seq: 0, role: "user", content: "Existing message", createdAt: CHAT.createdAt }],
};
const LOAD_ERROR = "The Chat could not be loaded.";

test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["browser-tests/fixtures/chat-thread.tsx"], bundle: true, write: false,
    outdir: "/tmp/agent-studio-chat-fixture", platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" } });
  server = createServer((request, response) => {
    const file = bundle.outputFiles.find(file => request.url === `/${file.path.split("/").at(-1)}`);
    response.setHeader("Content-Type", `${file ? file.path.endsWith(".css") ? "text/css" : "text/javascript" : "text/html"}; charset=utf-8`);
    response.end(file?.contents ?? '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/chat-thread.css"><div id="root"></div><script src="/chat-thread.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
test.beforeEach(async ({ page }) => { pageErrors = []; page.on("pageerror", error => pageErrors.push(error.message)); });
test.afterEach(() => { expect(pageErrors).toEqual([]); });

const failures: Record<string, (route: Route) => Promise<void>> = {
  "HTTP 503": route => route.fulfill({ status: 503, json: { error: "Database unavailable" } }),
  "network failure": route => route.abort("connectionfailed"),
  "malformed JSON": route => route.fulfill({ contentType: "application/json", body: "{" }),
  "missing conversation data": route => route.fulfill({ contentType: "application/json", body: "null" }),
};

for (const [failure, fail] of Object.entries(failures)) {
  test(`recovers an initial ${failure} through retry without losing the draft`, async ({ page }) => {
    let reads = 0;
    let sends = 0;
    await page.route("**/api/chats/chat-1**", async route => {
      if (route.request().method() === "POST") { sends += 1; return route.abort(); }
      reads += 1;
      return reads === 1 ? fail(route) : route.fulfill({ json: THREAD });
    });
    await page.goto(base);
    await expect(page.getByRole("alert")).toContainText(LOAD_ERROR);
    await expect(page.getByText("Loading…", { exact: true })).toHaveCount(0);
    const draft = page.getByRole("textbox", { name: "Message", exact: true });
    await draft.fill("Keep this draft");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    await draft.press("Enter");
    await expect(draft).toHaveValue("Keep this draft");
    expect(sends).toBe(0);
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page.getByText("Existing message", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Conversation" })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Try again", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await expect(draft).toHaveValue("Keep this draft");
    expect(reads).toBe(2);
    expect(sends).toBe(0);
  });
}

test("blocks sending until the initial read determines the conversation state", async ({ page }) => {
  let answer: (() => void) | undefined;
  const pending = new Promise<void>(resolve => { answer = resolve; });
  let sends = 0;
  await page.route("**/api/chats/chat-1**", async route => {
    if (route.request().method() === "POST") { sends += 1; return route.abort(); }
    await pending;
    return route.fulfill({ json: THREAD });
  });
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  try {
    await page.goto(base);
    await draft.fill("Wait for history");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    await draft.press("Enter");
    await expect(draft).toHaveValue("Wait for history");
    expect(sends).toBe(0);
  } finally {
    answer!();
  }
  await expect(page.getByText("Existing message", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
});

test("retains not-found behavior for an initial 404", async ({ page }) => {
  await page.route("**/api/chats/chat-1", route => route.fulfill({ status: 404, json: { error: "Not found" } }));
  await page.goto(base);
  await expect(page.getByText("Chat not found.", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toHaveCount(0);
});

test("redirects an expired session during the initial thread read", async ({ page }) => {
  await page.route("**/api/chats/chat-1**", route =>
    route.fulfill({ status: 401, json: { error: "Unauthorized" } }));
  await page.goto(`${base}/chats/chat-1`);
  await expect(page).toHaveURL(/\/login\?next=%2Fchats%2Fchat-1/);
});

test("opens a long Chat at the latest message and keeps manual scroll control", async ({ page }) => {
  const messages = Array.from({ length: 80 }, (_, seq) => ({
    chatId: CHAT.chatId, seq, role: seq % 2 ? "assistant" as const : "user" as const,
    content: `History ${seq}`, createdAt: CHAT.createdAt,
  }));
  await page.route("**/api/chats/chat-1**", route => route.fulfill({ json: { chat: CHAT, messages } satisfies ChatWithMessages }));
  await page.goto(base);
  const viewport = page.locator(".mantine-ScrollArea-viewport");
  await expect(page.getByText("History 79", { exact: true })).toBeAttached();
  await expect.poll(() => viewport.evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThan(3);
  await viewport.hover();
  await page.mouse.wheel(0, -2000);
  await expect(page.getByRole("button", { name: "Jump to the latest message" })).toBeVisible();
});

test("retains streamed content and its error while a failed tail read retries", async ({ page }) => {
  const reads: string[] = [];
  await page.route("**/api/chats/chat-1**", async route => {
    if (route.request().method() === "POST") {
      expect(route.request().postDataJSON()).toMatchObject({ content: "Next message" });
      return route.fulfill({ contentType: "text/event-stream", body: [
        { runId: "run-1", userSeq: 1 }, { delta: { content: "Streamed partial answer" } },
        { error: "Provider failed" }, { ended: true },
      ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") });
    }
    reads.push(new URL(route.request().url()).search);
    if (reads.length === 1) return route.fulfill({ json: THREAD });
    if (reads.length === 2) return route.fulfill({ status: 503, json: { error: "Temporary read failure" } });
    return route.fulfill({ json: { chat: CHAT, messages: [
      { chatId: CHAT.chatId, seq: 1, role: "user", content: "Next message", createdAt: CHAT.createdAt },
      { chatId: CHAT.chatId, seq: 2, role: "assistant", content: "Stored partial answer", createdAt: CHAT.createdAt },
    ] } satisfies ChatWithMessages });
  });
  await page.goto(base);
  await expect(page.getByText("Existing message", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Next message");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => reads.length).toBe(2);
  await expect(page.getByText("Streamed partial answer", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Provider failed");
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toHaveCount(0);
  await expect(page.getByText("Stored partial answer", { exact: true })).toBeVisible();
  await expect(page.getByText("Streamed partial answer", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Existing message", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Provider failed");
  expect(reads).toEqual(["", "?sinceSeq=0", "?sinceSeq=0"]);
});
