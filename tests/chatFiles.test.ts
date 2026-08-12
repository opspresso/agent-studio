import { describe, expect, it, vi } from "vitest";
import type { Chat, ChatMessage, ChatMessageFile } from "@/domain/chat/types";
import type { ChatRepository } from "@/domain/chat/repository";
import type { ProjectRepository, VersionRepository } from "@/domain/project/repository";
import type { EngineChunk } from "@/domain/llm/types";
import type { ChatDeps } from "@/application/chat/deps";
import { collectGeneratedFiles, runAndPersist } from "@/application/chat/run";
import { resolveFileUrl } from "@/domain/chat/fileRefs";
import { resolveMessageFiles } from "@/application/chat/resolveFiles";
import { toEngineMessages } from "@/application/chat/messageMapping";
import { reduceChunk } from "@/app/chats/_lib/stream";
import { EMPTY_TURN } from "@/app/chats/_lib/types";
import { VIEW_URL_TTL_SECONDS } from "@/application/artifact/urlTtl";

/**
 * A run rendered a PDF, the bracket stored it, and the chat had nowhere to put
 * the reference — so the transcript said a file had been delivered and offered
 * no way to get it. These pin the path from the chunk to the download.
 */

const CHAT: Chat = {
  chatId: "c1",
  title: "t",
  ownerEmail: "owner@x.com",
  projectName: "p1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const signed = async (key: string, ttl: number, options?: { downloadAs?: string }) =>
  `https://signed.example/${key}?ttl=${ttl}&as=${options?.downloadAs ?? ""}`;

function assistantWith(files: ChatMessageFile[]): ChatMessage {
  return {
    chatId: "c1",
    seq: 2,
    role: "assistant",
    content: "done",
    files,
    createdAt: "2026-08-12T15:15:00Z",
  };
}

describe("resolveFileUrl", () => {
  it("names the file the browser should save, not the object key", async () => {
    // The key is a UUID: without this the reader downloads
    // `c74d33ff-….pdf` and cannot tell which document it is.
    expect(
      await resolveFileUrl(
        { key: "artifacts/document/c74d33ff.pdf", name: "summary.pdf", mimeType: "application/pdf" },
        signed,
        60,
      ),
    ).toBe("https://signed.example/artifacts/document/c74d33ff.pdf?ttl=60&as=summary.pdf");
  });

  it("resolves to nothing without a signer, rather than a link that goes nowhere", async () => {
    expect(
      await resolveFileUrl({ key: "k", name: "a.pdf", mimeType: "application/pdf" }, undefined, 60),
    ).toBeUndefined();
  });
});

describe("resolveMessageFiles", () => {
  it("gives the reader an address and keeps what the row is for", async () => {
    const { messages } = await resolveMessageFiles(
      [assistantWith([{ key: "artifacts/document/x.pdf", name: "summary.pdf", mimeType: "application/pdf", byteSize: 1_605_516 }])],
      signed,
      VIEW_URL_TTL_SECONDS,
    );

    const file = messages[0]?.role === "assistant" ? messages[0].files?.[0] : undefined;
    expect(file?.url).toContain("as=summary.pdf");
    expect(file?.name).toBe("summary.pdf");
    expect(file?.byteSize).toBe(1_605_516);
    // The key never travels: the address is what a reader can use, and the key
    // is what a reader could guess other objects from.
    expect(file?.key).toBeUndefined();
  });

  it("drops one it could not sign, and says how many", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = async () => {
      throw new Error("no credentials");
    };

    const { messages, dropped } = await resolveMessageFiles(
      [assistantWith([{ key: "k", name: "a.pdf", mimeType: "application/pdf" }])],
      failing,
      VIEW_URL_TTL_SECONDS,
    );

    expect(dropped).toBe(1);
    expect(messages[0]?.role === "assistant" && messages[0].files).toEqual([]);
    vi.restoreAllMocks();
  });
});

describe("collectGeneratedFiles", () => {
  it("keeps the reference the bracket already stored", () => {
    const { stored, warnings } = collectGeneratedFiles(
      [{ key: "artifacts/document/x.pdf", name: "a.pdf", mimeType: "application/pdf", byteSize: 12 }],
      true,
    );

    expect(stored).toEqual([
      { key: "artifacts/document/x.pdf", name: "a.pdf", mimeType: "application/pdf", byteSize: 12 },
    ]);
    expect(warnings).toEqual([]);
  });

  /**
   * The asymmetry with images. An image that failed to store was still seen —
   * its bytes rode the stream. A file's are stripped as it is stored, so an
   * unstored one has been nowhere, and "shown for this turn only" would be a
   * promise of something the reader never had.
   */
  it("says the download does not exist when nothing stores files", () => {
    const { stored, warnings } = collectGeneratedFiles(
      [{ name: "a.pdf", mimeType: "application/pdf" }],
      false,
    );

    expect(stored).toEqual([]);
    expect(warnings[0]).toContain("nothing to download");
  });

  it("stays quiet when storage is configured, because the capture already spoke", () => {
    // Two warnings for one failure, one of them without the provider's reason,
    // is worse than the one that has it.
    const { warnings } = collectGeneratedFiles([{ name: "a.pdf", mimeType: "application/pdf" }], true);

    expect(warnings).toEqual([]);
  });
});

describe("runAndPersist", () => {
  function deps(): { deps: ChatDeps; messages: ChatMessage[] } {
    const messages: ChatMessage[] = [];
    let seq = 0;
    const chats = {
      async get() {
        return CHAT;
      },
      async listByOwner() {
        return [CHAT];
      },
      async create() {},
      async update() {},
      async delete() {},
      async listMessages() {
        return [] as ChatMessage[];
      },
      async claimRun() {
        return true;
      },
      async releaseRun() {},
      async getActiveRun() {
        return null;
      },
      async requestCancel() {
        return true;
      },
      async reserveMessageSeq() {
        return seq++;
      },
      async appendMessage(message: ChatMessage) {
        messages.push(message);
      },
    } satisfies ChatRepository;
    return {
      deps: {
        chats,
        runLog: { async append() {}, async read() { return []; } },
        projects: {} as ProjectRepository,
        versions: {} as VersionRepository,
        runAgent: () => (async function* () {})(),
        documents: { extract: async () => ({ text: "" }) },
        artifacts: {} as ChatDeps["artifacts"],
      },
      messages,
    };
  }

  async function drain(chatDeps: ChatDeps, chunks: EngineChunk[]): Promise<void> {
    async function* source(): AsyncGenerator<EngineChunk> {
      yield* chunks;
    }
    for await (const _ of runAndPersist(chatDeps, CHAT, source())) {
      // drained for its side effects
    }
  }

  it("puts a produced file on the assistant message", async () => {
    const fixture = deps();

    await drain(fixture.deps, [
      {
        file: {
          name: "deployment-method-summary.pdf",
          mimeType: "application/pdf",
          source: "mcp: render_document",
          byteSize: 1_605_516,
          key: "artifacts/document/c74d33ff.pdf",
        },
      },
      { delta: { content: "made it" } },
    ]);

    const assistant = fixture.messages.find((message) => message.role === "assistant");
    expect(assistant?.role === "assistant" && assistant.files).toEqual([
      {
        key: "artifacts/document/c74d33ff.pdf",
        name: "deployment-method-summary.pdf",
        mimeType: "application/pdf",
        byteSize: 1_605_516,
      },
    ]);
  });

  it("persists a run whose only output was a file", async () => {
    // Nothing was said and nothing was drawn. Before files counted toward the
    // turn being worth writing, this run persisted no message at all — and the
    // document it produced became unreachable from the conversation.
    const fixture = deps();

    await drain(fixture.deps, [
      { file: { name: "a.pdf", mimeType: "application/pdf", source: "mcp: x", key: "k" } },
    ]);

    expect(fixture.messages.some((message) => message.role === "assistant")).toBe(true);
  });
});

/**
 * The asymmetry that makes `EngineChunk.file` a separate axis in the first
 * place: a model cannot read bytes, the tool result text is what named the
 * file, and a replayed turn must not claim otherwise.
 */
describe("replay", () => {
  it("carries no trace of a stored file into the model's context", () => {
    const { messages } = toEngineMessages([
      { chatId: "c1", seq: 1, role: "user", content: "make a pdf", createdAt: "2026-08-12T15:14:00Z" },
      assistantWith([
        { key: "artifacts/document/x.pdf", name: "summary.pdf", mimeType: "application/pdf" },
      ]),
    ]);

    const serialised = JSON.stringify(messages);
    expect(serialised).not.toContain("summary.pdf");
    expect(serialised).not.toContain("artifacts/document");
  });
});

describe("the live turn", () => {
  it("folds a file chunk into the turn without bytes or an address", () => {
    const turn = reduceChunk(EMPTY_TURN, {
      file: { name: "a.pdf", mimeType: "application/pdf", byteSize: 99, key: "k" },
    });

    expect(turn.files).toEqual([{ name: "a.pdf", mimeType: "application/pdf", byteSize: 99 }]);
  });

  it("does not mistake a file for a picture", () => {
    // Ten consumers know `image`. A DOCX arriving on that axis is drawn in an
    // `<img>`, uploaded to Slack as a photo, and named `generated.png`.
    const turn = reduceChunk(EMPTY_TURN, {
      file: { name: "a.docx", mimeType: "application/vnd.openxmlformats-officedocument", key: "k" },
    });

    expect(turn.images).toEqual([]);
  });
});
