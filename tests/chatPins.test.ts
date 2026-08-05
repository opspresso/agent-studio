import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/domain/chat/types";
import { pinnedImages } from "@/app/chats/_lib/pins";

function message(seq: number, role: ChatMessage["role"]): ChatMessage {
  return { chatId: "c1", seq, role, content: "", createdAt: "" } as ChatMessage;
}

const ATTACHMENT = { b64: "AAAA", mimeType: "image/png", name: "shot.png" };

describe("pinnedImages", () => {
  /**
   * The scan runs backwards on purpose: a thread holds every earlier turn, and
   * the bytes on screen belong to the newest of each role.
   */
  it("pins the turn's own rows, not an earlier turn's", () => {
    const messages = [
      message(0, "user"),
      message(1, "assistant"),
      message(2, "user"),
      message(3, "tool"),
      message(4, "assistant"),
    ];
    const pinned = pinnedImages(messages, {
      attachments: [ATTACHMENT],
      images: [{ b64: "BBBB", mimeType: "image/png" }],
    });
    expect(Object.keys(pinned)).toEqual(["2", "4"]);
  });

  it("keeps a generated image's prompt and omits it when there is none", () => {
    const pinned = pinnedImages([message(0, "assistant")], {
      attachments: [],
      images: [
        { b64: "AAAA", mimeType: "image/png", prompt: "a cat" },
        { b64: "BBBB", mimeType: "image/png" },
      ],
    });
    expect(pinned[0]).toEqual([
      { url: expect.stringContaining("data:image/png;base64,AAAA"), prompt: "a cat" },
      { url: expect.stringContaining("data:image/png;base64,BBBB") },
    ]);
  });

  it("pins nothing when the turn carried no images either way", () => {
    expect(pinnedImages([message(0, "user")], { attachments: [], images: [] })).toEqual({});
  });

  it("pins nothing when the thread has no row of that role to pin to", () => {
    expect(
      pinnedImages([message(0, "assistant")], { attachments: [ATTACHMENT], images: [] }),
    ).toEqual({});
  });
});
