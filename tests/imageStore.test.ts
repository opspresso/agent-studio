process.env.S3_BUCKET_NAME ??= "test-bucket";

import { describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatMessageImage } from "@/domain/chat/types";
import type { ImageStore } from "@/domain/chat/imageStore";
import { MAX_RUN_DURATION_MS } from "@/shared/runDeadline";

const sent: Array<{ input: Record<string, unknown> }> = [];

vi.mock("@aws-sdk/client-s3", () => {
  class Command {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    PutObjectCommand: Command,
    GetObjectCommand: Command,
    S3Client: class {
      async send(command: { input: Record<string, unknown> }) {
        sent.push(command);
        return {};
      }
    },
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: async (
    _client: unknown,
    command: { input: { Key: string } },
    options: { expiresIn: number },
  ) => `https://signed.example/${command.input.Key}?expires=${options.expiresIn}`,
}));

import { s3ImageStore } from "@/infrastructure/storage/s3ImageStore";
import {
  IMAGE_REPLAY_TTL_SECONDS,
  IMAGE_VIEW_TTL_SECONDS,
  withSignedImages,
} from "@/application/chat/imageUrls";

function userMessage(images: ChatMessageImage[]): ChatMessage {
  return { chatId: "c1", seq: 0, role: "user", content: "hi", images, createdAt: "2026-01-01" };
}

describe("s3ImageStore", () => {
  it("writes with no public ACL and returns the object key, not a URL", async () => {
    sent.length = 0;
    const key = await s3ImageStore.put({ b64: "aW1n", mimeType: "image/png" });

    // What is persisted is a key. A URL stored here would outlive every check
    // on it — which is exactly what public-read objects did.
    expect(key).toMatch(/^images\/[0-9a-f-]+\.png$/);
    expect(key).not.toContain("https://");

    const put = sent.at(-1)?.input ?? {};
    expect(put).toMatchObject({ Bucket: "test-bucket", ContentType: "image/png" });
    expect(put).not.toHaveProperty("ACL");
    // `private`: the URL a reader gets is signed for that read, so a shared
    // cache holding the response would hand the object to whoever asked next.
    expect(String(put.CacheControl)).toContain("private");
    expect(String(put.CacheControl)).not.toContain("public");
  });

  it("signs a GET for a stored key, bounded by the requested lifetime", async () => {
    expect(await s3ImageStore.signUrl("images/x.png", 900)).toBe(
      "https://signed.example/images/x.png?expires=900",
    );
  });
});

describe("image URL resolution", () => {
  const store: ImageStore = {
    put: async () => "images/new.png",
    signUrl: async (key, expiresIn) => `https://signed.example/${key}?expires=${expiresIn}`,
  };

  it("resolves a stored key to a signed URL", async () => {
    const [message] = await withSignedImages(
      store,
      [userMessage([{ key: "images/a.png", prompt: "a cat" }])],
      IMAGE_VIEW_TTL_SECONDS,
    );
    expect(message?.role === "user" && message.images).toEqual([
      { url: `https://signed.example/images/a.png?expires=${IMAGE_VIEW_TTL_SECONDS}`, prompt: "a cat" },
    ]);
  });

  it("passes a legacy public URL through untouched", async () => {
    // Rows written while the bucket was public-read recorded no key, so there
    // is nothing to sign — and the address still works.
    const [message] = await withSignedImages(
      store,
      [userMessage([{ url: "https://bucket.s3.example.com/images/old.png" }])],
      IMAGE_VIEW_TTL_SECONDS,
    );
    expect(message?.role === "user" && message.images).toEqual([
      { url: "https://bucket.s3.example.com/images/old.png" },
    ]);
  });

  it("drops an image it cannot sign rather than rendering a broken one", async () => {
    const failing: ImageStore = {
      put: store.put,
      signUrl: async () => {
        throw new Error("AccessDenied");
      },
    };
    const [message] = await withSignedImages(
      failing,
      [userMessage([{ key: "images/a.png" }, { url: "https://kept.example/b.png" }])],
      IMAGE_VIEW_TTL_SECONDS,
    );
    expect(message?.role === "user" && message.images).toEqual([
      { url: "https://kept.example/b.png" },
    ]);
  });

  it("drops a key when the deployment has no store to sign it with", async () => {
    const [message] = await withSignedImages(
      undefined,
      [userMessage([{ key: "images/a.png" }])],
      IMAGE_VIEW_TTL_SECONDS,
    );
    expect(message?.role === "user" && message.images).toEqual([]);
  });

  it("signs a replayed attachment for longer than a run can last", async () => {
    // The provider fetches a replayed URL at some point *during* the run, not
    // when it was minted, so a signature that expires with the request would
    // hand the model a 403 halfway through.
    expect(IMAGE_REPLAY_TTL_SECONDS).toBeGreaterThan(MAX_RUN_DURATION_MS / 1000);
  });
});
