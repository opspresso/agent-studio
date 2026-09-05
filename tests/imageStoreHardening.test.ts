import { describe, expect, it } from "vitest";
import { resolveImageUrl } from "@/domain/chat/imageRefs";
import {
  MAX_CONCURRENT_CHAT_IMAGE_RESOLUTIONS,
  resolveMessageImages,
  resolveRunMessageImages,
} from "@/application/chat/resolveImages";
import { VIEW_URL_TTL_SECONDS } from "@/shared/artifactUrlTtl";
import { toEngineMessages } from "@/application/chat/messageMapping";
import type { ArtifactObjectStore } from "@/domain/artifact/objectStore";
import type { ChatMessage, ChatMessageImage } from "@/domain/chat/types";

/**
 * Generated image rows carry object keys and mint addresses at read time. A
 * long-lived public URL in the row would give anyone holding a transcript a
 * durable capability.
 */

const signed = async (key: string, ttl: number) => `https://signed.example/${key}?ttl=${ttl}`;

function assistant(images: ChatMessageImage[]): ChatMessage {
  return {
    chatId: "c1",
    seq: 2,
    role: "assistant",
    content: "here",
    images,
    createdAt: "2026-08-03T10:00:00Z",
  } as ChatMessage;
}

describe("resolveImageUrl", () => {
  it("signs a stored key", async () => {
    expect(await resolveImageUrl({ key: "images/a.png" }, signed, 60)).toBe(
      "https://signed.example/images/a.png?ttl=60",
    );
  });

  it("passes a legacy public URL through untouched", async () => {
    // The objects behind these are already public, so rewriting the row would
    // change nothing about who can reach them — and would break the read.
    const legacy = "https://bucket.s3.ap-northeast-2.amazonaws.com/images/old.png";
    expect(await resolveImageUrl({ url: legacy }, signed, 60)).toBe(legacy);
  });

  it("prefers the legacy URL when a row somehow carries both", async () => {
    expect(await resolveImageUrl({ url: "https://legacy", key: "images/a.png" }, signed, 60)).toBe(
      "https://legacy",
    );
  });

  it("resolves to nothing when there is no signer", async () => {
    // Storage unconfigured: a key with no way to sign it is an image nothing can
    // display, and saying so beats rendering a broken address.
    expect(await resolveImageUrl({ key: "images/a.png" }, undefined, 60)).toBeUndefined();
  });
});

describe("resolveMessageImages", () => {
  it("resolves either stored reference form for the view", async () => {
    const legacy = "https://bucket.s3.ap-northeast-2.amazonaws.com/images/old.png";
    const { messages: [message] } = await resolveMessageImages(
      [assistant([{ key: "images/new.png", prompt: "a cat" }, { url: legacy }])],
      signed,
      VIEW_URL_TTL_SECONDS,
    );
    expect(message?.role === "assistant" && message.images).toEqual([
      { url: `https://signed.example/images/new.png?ttl=${VIEW_URL_TTL_SECONDS}`, prompt: "a cat" },
      { url: legacy },
    ]);
  });

  it("drops an image it could not sign instead of emitting a broken address", async () => {
    // In the view an unfetchable URL tells the reader nothing.
    const failing = async () => {
      throw new Error("no credentials");
    };
    const { messages: [message], dropped } = await resolveMessageImages(
      [assistant([{ key: "images/new.png" }])],
      failing,
      60,
    );
    expect(message?.role === "assistant" && message.images).toEqual([]);
    // Counted, not just dropped: a picture missing from the transcript with
    // nothing said reads as the chat having lost it, and the reader is the only
    // one who can tell whether that matters.
    expect(dropped).toBe(1);
  });

  it("reports nothing dropped when every image resolved", async () => {
    const { dropped } = await resolveMessageImages(
      [assistant([{ key: "images/new.png" }, { url: "https://bucket/old.png" }])],
      signed,
      60,
    );
    expect(dropped).toBe(0);
  });

  it("leaves a message with no images untouched", async () => {
    const plain: ChatMessage = {
      chatId: "c1",
      seq: 1,
      role: "user",
      content: "hi",
      createdAt: "2026-08-03T10:00:00Z",
    };
    const { messages: [message] } = await resolveMessageImages([plain], signed, 60);
    expect(message).toBe(plain);
  });

  it("passes a tool row through, which cannot carry images at all", async () => {
    const tool: ChatMessage = {
      chatId: "c1",
      seq: 3,
      role: "tool",
      content: "result",
      toolCallId: "call_1",
      createdAt: "2026-08-03T10:00:00Z",
    };
    const { messages: [message] } = await resolveMessageImages([tool], signed, 60);
    expect(message).toBe(tool);
  });

  it("bounds signer concurrency across the full transcript", async () => {
    let active = 0;
    let maxActive = 0;
    const release: Array<() => void> = [];
    const signer = async (key: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => release.push(resolve));
      active -= 1;
      return `https://signed.example/${key}`;
    };
    const messages = Array.from(
      { length: MAX_CONCURRENT_CHAT_IMAGE_RESOLUTIONS + 2 },
      (_, index) => assistant([{ key: `image-${index}` }]),
    );

    const pending = resolveMessageImages(messages, signer, VIEW_URL_TTL_SECONDS);
    await expect.poll(() => active).toBe(MAX_CONCURRENT_CHAT_IMAGE_RESOLUTIONS);
    while (release.length > 0) {
      release.shift()?.();
      await Promise.resolve();
    }
    await pending;

    expect(maxActive).toBe(MAX_CONCURRENT_CHAT_IMAGE_RESOLUTIONS);
  });
});

describe("resolveRunMessageImages", () => {
  it("preserves an image-only turn's loss through resolution and replay mapping", async () => {
    const original: ChatMessage[] = [
      {
        chatId: "c1",
        seq: 7,
        role: "user",
        content: "",
        images: [{ url: "https://bucket.example/legacy.png" }],
        createdAt: "2026-08-03T10:00:00Z",
      },
      {
        chatId: "c1",
        seq: 8,
        role: "user",
        content: "",
        images: [],
        createdAt: "2026-08-03T10:00:01Z",
      },
    ];

    const resolved = await resolveRunMessageImages(original, undefined);
    const replay = toEngineMessages(resolved.messages, {
      droppedImageSeqs: resolved.droppedImageSeqs,
    });

    expect(replay.messages).toEqual([
      { role: "user", content: "[The image(s) attached to this turn are no longer available.]" },
      { role: "user", content: "" },
    ]);
    expect(original[0]?.role !== "tool" && original[0]?.images).toEqual([
      { url: "https://bucket.example/legacy.png" },
    ]);
  });

  it("inlines only the newest four stored images and never signs the rest", async () => {
    const reads: string[] = [];
    const sign = async () => {
      throw new Error("run replay must not sign image URLs");
    };
    const objects: ArtifactObjectStore = {
      put: async () => {},
      read: async (key) => {
        reads.push(key);
        return { bytes: Buffer.from(key), mimeType: "image/png" };
      },
      sign,
      delete: async () => {},
    };
    const messages = Array.from({ length: 6 }, (_, index) =>
      assistant([{ key: `images/${index}.png` }]),
    );

    const resolved = await resolveRunMessageImages(messages, objects);

    expect(reads).toEqual([
      "images/2.png",
      "images/3.png",
      "images/4.png",
      "images/5.png",
    ]);
    expect(resolved.dropped).toBe(2);
    expect(JSON.stringify(resolved.messages)).not.toContain("https://");
    expect(JSON.stringify(resolved.messages)).toContain("data:image/png;base64,");
  });

  it("drops a legacy remote URL instead of handing it to the model", async () => {
    const resolved = await resolveRunMessageImages(
      [assistant([{ url: "https://bucket.example/legacy.png" }])],
      undefined,
    );

    expect(resolved.dropped).toBe(1);
    expect(resolved.messages[0]?.role === "assistant" && resolved.messages[0].images).toEqual([]);
  });
});
