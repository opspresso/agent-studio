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

test("shows only the final file across live output, tail synchronization and reload", async ({ page }) => {
  const original = { chatId: CHAT.chatId, seq: 1, role: "assistant" as const, content: "Original report", createdAt: CHAT.createdAt,
    files: [{ artifactId: "old", name: "report.html", mimeType: "text/html", byteSize: 100, url: "https://files.test/old" }] };
  const final = { ...original, seq: 3, content: "Final report", files: [{ ...original.files[0]!, artifactId: "final",
    replacedArtifactIds: ["old"], url: "https://files.test/final" }] };
  let finished = false;
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (String(input) !== "/api/chats/chat-1/messages" || init?.method !== "POST") return originalFetch(input, init);
      return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        const send = (frame: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
        send({ runId: "run-1", userSeq: 2 }); send({ delta: { content: "Checking the report" } });
        window.addEventListener("publish-final-file", () => send({ file: { artifactId: "final", replacedArtifactIds: ["old"],
          key: "final-key", name: "report.html", mimeType: "text/html", byteSize: 120 } }), { once: true });
        window.addEventListener("finish-file-run", () => { send({ ended: true }); controller.close(); }, { once: true });
      } }), { headers: { "Content-Type": "text/event-stream" } }));
    };
  });
  await page.route("**/api/chats/chat-1**", route => {
    const tail = new URL(route.request().url()).search;
    return route.fulfill({ json: { chat: CHAT, messages: finished
      ? tail ? [final] : [...THREAD.messages, { ...original, files: [] }, final]
      : [...THREAD.messages, original] } });
  });
  await page.goto(base);
  await expect(page.locator('a[href="/api/artifacts/old/view"]')).toBeVisible();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Correct the report");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Checking the report", { exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("publish-final-file")));
  await expect(page.locator('a[href="/api/artifacts/old/view"]')).toHaveCount(0);
  await expect(page.locator('a[href="/api/artifacts/final/view"]')).toBeVisible();
  await expect(page.getByText("report.html", { exact: true })).toHaveCount(1);
  finished = true;
  await page.evaluate(() => window.dispatchEvent(new Event("finish-file-run")));
  await expect(page.getByRole("link", { name: "report.html", exact: true })).toHaveAttribute("href", "https://files.test/final");
  await expect(page.getByText("report.html", { exact: true })).toHaveCount(1);
  await page.reload();
  await expect(page.getByText("report.html", { exact: true })).toHaveCount(1);
  await expect(page.locator('a[href="/api/artifacts/final/view"]')).toBeVisible();
  await page.screenshot({ path: "/tmp/agent-studio-final-file-preview.png" });
});

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
    await expect(page.getByRole("heading", { name: "Chat", level: 1, exact: true })).toBeVisible();
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
    await expect(page.getByRole("heading", { name: "Chat", level: 1, exact: true })).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "Chat", level: 1, exact: true })).toBeVisible();
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

test("reports a refused Stop and lets the reader retry without dropping the reply", async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (String(input) === "/api/chats/chat-1/messages" && init?.method === "POST") {
        return Promise.resolve(new Response(new ReadableStream({ start(controller) {
          const frames = [{ runId: "run-1", userSeq: 1 }, { delta: { content: "Answer still streaming" } }];
          controller.enqueue(new TextEncoder().encode(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("")));
        } }), { headers: { "Content-Type": "text/event-stream" } }));
      }
      return original(input, init);
    };
  });
  await page.route("**/api/chats/chat-1", route => route.fulfill({ json: THREAD }));
  let stops = 0;
  await page.route("**/api/chats/chat-1/runs/run-1", route => {
    expect(route.request().method()).toBe("DELETE");
    stops += 1;
    return stops === 1
      ? route.fulfill({ status: 503, json: { error: "Cancellation unavailable" } })
      : route.fulfill({ json: { cancelled: true } });
  });
  await page.goto(base);
  await expect(page.getByText("Existing message", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Next message");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Answer still streaming", { exact: true })).toBeVisible();
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  await stop.click();
  await expect(page.getByRole("alert")).toContainText("Cancellation unavailable");
  await expect(stop).toBeVisible();
  await stop.click();
  await expect.poll(() => stops).toBe(2);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("Answer still streaming", { exact: true })).toBeVisible();
  await expect(stop).toBeVisible();
});

for (const outcome of ["completed", "provider-failed", "connection-lost"] as const) {
  test(`announces completion only for a completed answer (${outcome})`, async ({ page }) => {
    await page.addInitScript((outcome) => {
      const original = window.fetch.bind(window);
      window.fetch = (input, init) => {
        if (String(input) === "/api/chats/chat-1/messages" && init?.method === "POST") {
          return Promise.resolve(new Response(new ReadableStream({ start(controller) {
            const encode = (frames: unknown[]) => new TextEncoder().encode(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""));
            controller.enqueue(encode([{ runId: "run-1", userSeq: 1 }, { delta: { content: "Streamed answer" } }]));
            window.addEventListener("finish-fixture-run", () => {
              if (outcome === "connection-lost") { controller.error(new Error("Connection lost")); return; }
              controller.enqueue(encode([...(outcome === "provider-failed" ? [{ error: "Provider failed" }] : []), { ended: true }]));
              controller.close();
            }, { once: true });
          } }), { headers: { "Content-Type": "text/event-stream" } }));
        }
        return original(input, init);
      };
    }, outcome);
    await page.route("**/api/chats/chat-1**", route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/runs/run-1")) return route.fulfill({ json: { active: true } });
      if (url.pathname.endsWith("/stream")) return route.fulfill({ status: 503, json: { error: "Reconnect unavailable" } });
      // Keep the live answer mounted while the stored replacement is unavailable.
      return url.search ? route.fulfill({ status: 503, json: { error: "History unavailable" } }) : route.fulfill({ json: THREAD });
    });
    await page.goto(base);
    await expect(page.getByText("Existing message", { exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Next message");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("Streamed answer", { exact: true })).toBeVisible();
    const completion = page.getByRole("status").filter({ hasText: "Answer complete" });
    await expect(completion).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new Event("finish-fixture-run")));
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    if (outcome === "completed") {
      await expect(completion).toHaveCount(1);
    } else {
      await expect(page.getByRole("alert")).toContainText(outcome === "provider-failed" ? "Provider failed" : "Reconnect unavailable");
      await expect(completion).toHaveCount(0);
    }
  });
}
