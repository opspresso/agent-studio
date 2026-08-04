import { describe, expect, it } from "vitest";
import { resolveImageUrl } from "@/domain/chat/imageRefs";
import { resolveMessageImages } from "@/application/chat/resolveImages";
import {
  REPLAY_URL_TTL_SECONDS,
  VIEW_URL_TTL_SECONDS,
} from "@/application/chat/imageUrls";
import { MAX_RUN_DURATION_MS } from "@/shared/runDeadline";
import type { ChatMessage, ChatMessageImage } from "@/domain/chat/types";

/**
 * A generated image used to be stored as a public URL with a one-year immutable
 * cache and nothing that ever expired it, so anyone holding a transcript held a
 * working link forever. Rows now carry the object key and the address is minted
 * at read time.
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

describe("the two lifetimes", () => {
  it("gives a replay longer than a whole run can last", async () => {
    // The provider fetches this URL, at whatever point in the run it reaches the
    // turn — a signature that expired mid-run would fail a turn on an image the
    // user can see in their own transcript.
    expect(REPLAY_URL_TTL_SECONDS).toBeGreaterThan(MAX_RUN_DURATION_MS / 1000);
  });

  it("keeps the view's window short, since a person already has the page", () => {
    expect(VIEW_URL_TTL_SECONDS).toBeLessThan(REPLAY_URL_TTL_SECONDS);
  });

  it("derives the replay window from the run deadline rather than hardcoding it", () => {
    // A literal would silently become too short the first time someone raised
    // MAX_RUN_DURATION_MS.
    expect(REPLAY_URL_TTL_SECONDS).toBe(Math.ceil(MAX_RUN_DURATION_MS / 1000) + 15 * 60);
  });
});

describe("resolveMessageImages", () => {
  it("hands both readers a url, whichever form the row is in", async () => {
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

  it("signs a replay with the replay's own lifetime", async () => {
    const { messages: [message] } = await resolveMessageImages(
      [assistant([{ key: "images/new.png" }])],
      signed,
      REPLAY_URL_TTL_SECONDS,
    );
    expect(message?.role === "assistant" && message.images?.[0]?.url).toContain(
      `ttl=${REPLAY_URL_TTL_SECONDS}`,
    );
  });

  it("drops an image it could not sign instead of emitting a broken address", async () => {
    // On the replay path an unfetchable URL fails the whole turn; in the view it
    // tells the reader nothing.
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
});
