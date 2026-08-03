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

  describe("recovering the key from an address this bucket was reachable by", () => {
    it("reads both forms S3 has ever served", () => {
      expect(
        s3ImageStore.keyFromUrl("https://test-bucket.s3.ap-northeast-2.amazonaws.com/images/a.png"),
      ).toBe("images/a.png");
      expect(s3ImageStore.keyFromUrl("https://test-bucket.s3.amazonaws.com/images/a.png")).toBe(
        "images/a.png",
      );
      expect(
        s3ImageStore.keyFromUrl("https://s3.ap-northeast-2.amazonaws.com/test-bucket/images/a.png"),
      ).toBe("images/a.png");
    });

    it("refuses an address that is not this bucket's", () => {
      // Signing a key we do not hold produces a URL that 404s, which is worse
      // than an honest "this could not be loaded".
      expect(
        s3ImageStore.keyFromUrl("https://someone-else.s3.amazonaws.com/images/a.png"),
      ).toBeNull();
      expect(
        s3ImageStore.keyFromUrl("https://s3.amazonaws.com/other-bucket/images/a.png"),
      ).toBeNull();
      expect(s3ImageStore.keyFromUrl("https://cdn.example.com/images/a.png")).toBeNull();
      expect(s3ImageStore.keyFromUrl("not a url")).toBeNull();
    });
  });
});

describe("image URL resolution", () => {
  const store: ImageStore = {
    keyFromUrl: () => null,
    put: async () => "images/new.png",
    signUrl: async (key, expiresIn) => `https://signed.example/${key}?expires=${expiresIn}`,
  };

  it("resolves a stored key to a signed URL", async () => {
    const { messages: [message] } = await withSignedImages(
      store,
      [userMessage([{ key: "images/a.png", prompt: "a cat" }])],
      IMAGE_VIEW_TTL_SECONDS,
    );
    expect(message?.role === "user" && message.images).toEqual([
      { url: `https://signed.example/images/a.png?expires=${IMAGE_VIEW_TTL_SECONDS}`, prompt: "a cat" },
    ]);
  });

  it("passes a legacy URL through when it names something this store does not hold", async () => {
    // Not ours to re-sign, and the address may still work — this is the only
    // arm left for a row written before keys were stored.
    const { messages: [message] } = await withSignedImages(
      store,
      [userMessage([{ url: "https://cdn.example.com/images/old.png" }])],
      IMAGE_VIEW_TTL_SECONDS,
    );
    expect(message?.role === "user" && message.images).toEqual([
      { url: "https://cdn.example.com/images/old.png" },
    ]);
  });

  it("re-signs a legacy URL that names one of its own objects", async () => {
    // Rows written while the bucket was public-read recorded an absolute URL
    // and no key. Passing those through was right only while the bucket stayed
    // public — and making it private is the deployment step that ships with the
    // change, so every one of these broke the moment an operator followed the
    // instructions. The address still names the object.
    const recovering: ImageStore = {
      ...store,
      keyFromUrl: (url) => url.split("/").slice(3).join("/") || null,
    };
    const { messages, warnings } = await withSignedImages(
      recovering,
      [userMessage([{ url: "https://test-bucket.s3.amazonaws.com/images/old.png" }])],
      IMAGE_VIEW_TTL_SECONDS,
    );
    const message = messages[0];
    expect(message?.role === "user" && message.images).toEqual([
      { url: `https://signed.example/images/old.png?expires=${IMAGE_VIEW_TTL_SECONDS}` },
    ]);
    expect(warnings).toEqual([]);
  });

  it("drops an image it cannot sign rather than rendering a broken one", async () => {
    const failing: ImageStore = {
      keyFromUrl: () => null,
      put: store.put,
      signUrl: async () => {
        throw new Error("AccessDenied");
      },
    };
    const { messages, warnings } = await withSignedImages(
      failing,
      [userMessage([{ key: "images/a.png" }, { url: "https://kept.example/b.png" }])],
      IMAGE_VIEW_TTL_SECONDS,
    );
    const message = messages[0];
    expect(message?.role === "user" && message.images).toEqual([
      { url: "https://kept.example/b.png" },
    ]);
    // Dropping it is right; dropping it silently is not. A transcript one
    // picture short reads as one that never had it.
    expect(warnings).toEqual(["1 image in this conversation could not be loaded and is not shown."]);
  });

  it("counts every drop across the transcript in one warning", async () => {
    const { warnings } = await withSignedImages(
      undefined,
      [userMessage([{ key: "images/a.png" }]), userMessage([{ key: "images/b.png" }])],
      IMAGE_VIEW_TTL_SECONDS,
    );
    expect(warnings).toEqual([
      "2 images in this conversation could not be loaded and are not shown.",
    ]);
  });

  it("says nothing when nothing was lost", async () => {
    const { warnings } = await withSignedImages(
      store,
      [userMessage([{ key: "images/a.png" }])],
      IMAGE_VIEW_TTL_SECONDS,
    );
    expect(warnings).toEqual([]);
  });

  it("drops a key when the deployment has no store to sign it with", async () => {
    const { messages: [message] } = await withSignedImages(
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
