import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureRunArtifacts, createArtifactRecorder } from "@/application/artifact/runArtifacts";
import { MAX_ARTIFACT_PROMPT_CHARS, storeArtifact } from "@/application/artifact/storeArtifact";
import type { ArtifactStorage } from "@/application/artifact/storeArtifact";
import type { Artifact } from "@/domain/artifact/types";
import type { EngineChunk } from "@/domain/llm/types";

const NOW = "2026-08-12T04:00:00.000Z";
const CONTEXT = {
  projectName: "poster-bot",
  actor: { kind: "user" as const, id: "bruce@daangn.com" },
  ancestry: ["poster-bot"],
  runId: "run-1",
};

interface Fake extends ArtifactStorage {
  puts: Array<{ key: string; bytes: Uint8Array; mimeType: string }>;
  rowsWritten: Artifact[];
  /** Every call in order, so the object-before-row contract can be asserted. */
  calls: string[];
}

function fakeStorage(over: { putFails?: boolean; rowFails?: boolean; error?: Error } = {}): Fake {
  const fake: Fake = {
    puts: [],
    rowsWritten: [],
    calls: [],
    objects: {
      async put(input) {
        fake.calls.push("object.put");
        if (over.putFails) {
          throw over.error ?? new Error("s3 down");
        }
        fake.puts.push(input);
      },
      async sign(key) {
        return `https://signed/${key}`;
      },
      async read() {
        return { bytes: new Uint8Array(), mimeType: "application/octet-stream" };
      },
      async delete() {
        fake.calls.push("object.delete");
      },
    },
    rows: {
      async put(artifact) {
        fake.calls.push("row.put");
        if (over.rowFails) {
          throw new Error("dynamo down");
        }
        fake.rowsWritten.push(artifact);
      },
      async get() {
        return null;
      },
      async listByProject() {
        return [];
      },
      async listByOwner() {
        return [];
      },
      async delete() {},
    },
  };
  return fake;
}

async function* stream(...chunks: EngineChunk[]): AsyncGenerator<EngineChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

async function collect(source: AsyncGenerator<EngineChunk>): Promise<EngineChunk[]> {
  const out: EngineChunk[] = [];
  for await (const chunk of source) {
    out.push(chunk);
  }
  return out;
}

const PNG = Buffer.from("fake-png-bytes").toString("base64");
const DOCX = Buffer.from("fake-docx-bytes").toString("base64");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("storeArtifact", () => {
  it("writes the object before the row", async () => {
    // The reverse order can leave a row naming bytes that were never written —
    // an artifact whose preview is broken forever, and which the caller has
    // already been told succeeded.
    const storage = fakeStorage();
    await storeArtifact(storage, CONTEXT, {
      kind: "image",
      source: "generated",
      bytes: Buffer.from("bytes"),
      mimeType: "image/png",
    });
    expect(storage.calls).toEqual(["object.put", "row.put"]);
  });

  it("derives the object key from the row's id", async () => {
    const storage = fakeStorage();
    const artifact = await storeArtifact(storage, CONTEXT, {
      kind: "image",
      source: "generated",
      bytes: Buffer.from("bytes"),
      mimeType: "image/png",
    });
    expect(artifact.key).toBe(`artifacts/image/${artifact.artifactId}.png`);
    expect(storage.puts[0]?.key).toBe(artifact.key);
  });

  it("carries the run's own attribution rather than restating it", async () => {
    const storage = fakeStorage();
    const artifact = await storeArtifact(storage, CONTEXT, {
      kind: "image",
      source: "generated",
      bytes: Buffer.from("bytes"),
      mimeType: "image/png",
      producedBy: "image-child",
    });
    expect(artifact).toMatchObject({
      projectName: "poster-bot",
      actor: { kind: "user", id: "bruce@daangn.com" },
      ancestry: ["poster-bot"],
      producedBy: "image-child",
      runId: "run-1",
      byteSize: 5,
      createdAt: NOW,
    });
  });

  it("truncates the prompt kept beside the bytes", async () => {
    // It outlives the chat message that carried it, so it is enough to
    // recognise the picture rather than a copy of the conversation.
    const storage = fakeStorage();
    const artifact = await storeArtifact(storage, CONTEXT, {
      kind: "image",
      source: "generated",
      bytes: Buffer.from("bytes"),
      mimeType: "image/png",
      prompt: "가".repeat(MAX_ARTIFACT_PROMPT_CHARS + 200),
    });
    expect(artifact.prompt).toHaveLength(MAX_ARTIFACT_PROMPT_CHARS);
  });

  it("omits absent fields rather than writing empty ones", async () => {
    const storage = fakeStorage();
    const artifact = await storeArtifact(
      storage,
      { projectName: "p" },
      { kind: "document", source: "generated", bytes: Buffer.from("x"), mimeType: "application/pdf" },
    );
    expect(artifact.actor).toBeUndefined();
    expect(artifact.ancestry).toBeUndefined();
    expect(artifact.prompt).toBeUndefined();
    expect(artifact.filename).toBeUndefined();
  });
});

describe("captureRunArtifacts", () => {
  it("leaves the stream untouched with no recorder", async () => {
    // A deployment with no object storage runs exactly as it did.
    const chunks = [{ delta: { content: "hi" } }, { image: { b64: PNG, mimeType: "image/png" } }];
    expect(await collect(captureRunArtifacts(undefined, stream(...chunks)))).toEqual(chunks);
  });

  it("keeps an image's bytes and adds the stored reference", async () => {
    // The bytes stay because a live view renders them as they arrive; the key is
    // only needed by a reader that comes back later.
    const storage = fakeStorage();
    const recorder = createArtifactRecorder(storage, CONTEXT);
    const [chunk] = await collect(
      captureRunArtifacts(recorder, stream({ image: { b64: PNG, mimeType: "image/png", prompt: "a poster" } })),
    );
    expect(chunk?.image?.b64).toBe(PNG);
    expect(chunk?.image?.artifactId).toBe(storage.rowsWritten[0]?.artifactId);
    expect(chunk?.image?.key).toBe(storage.rowsWritten[0]?.key);
    expect(storage.rowsWritten[0]).toMatchObject({ kind: "image", source: "generated", prompt: "a poster" });
  });

  it("strips a file's bytes and leaves the reference", async () => {
    // A rendered document has nothing to draw, so pushing megabytes of base64
    // down an SSE connection to produce a download link is pure cost.
    const storage = fakeStorage();
    const recorder = createArtifactRecorder(storage, CONTEXT);
    const [chunk] = await collect(
      captureRunArtifacts(
        recorder,
        stream({
          file: { b64: DOCX, mimeType: "application/pdf", name: "report.pdf", source: "mcp: render_document" },
        }),
      ),
    );
    expect(chunk?.file?.b64).toBeUndefined();
    expect(chunk?.file?.name).toBe("report.pdf");
    expect(chunk?.file?.byteSize).toBe(Buffer.from(DOCX, "base64").byteLength);
    expect(chunk?.file?.artifactId).toBe(storage.rowsWritten[0]?.artifactId);
    expect(storage.rowsWritten[0]).toMatchObject({ kind: "document", filename: "report.pdf" });
  });

  it("records the subagent that actually produced it", async () => {
    const storage = fakeStorage();
    const recorder = createArtifactRecorder(storage, CONTEXT);
    await collect(
      captureRunArtifacts(
        recorder,
        stream({ author: "image-child", image: { b64: PNG, mimeType: "image/png" } }),
      ),
    );
    expect(storage.rowsWritten[0]?.producedBy).toBe("image-child");
  });

  it("records the full transfer chain that produced an artifact", async () => {
    const storage = fakeStorage();
    const recorder = createArtifactRecorder(storage, CONTEXT);
    await collect(
      captureRunArtifacts(
        recorder,
        stream({
          author: "renderer",
          authorPath: ["researcher", "renderer"],
          image: { b64: PNG, mimeType: "image/png" },
        }),
      ),
    );

    expect(storage.rowsWritten[0]?.ancestry).toEqual([
      "poster-bot",
      "researcher",
      "renderer",
    ]);
  });

  it("records the model the producer named, not the run's", async () => {
    // The version this run answers on is `poster-bot/v3`; the picture was drawn
    // by a child on its own model. Deriving the model from the run instead would
    // file the child's work under the parent's name with nothing saying so.
    const storage = fakeStorage();
    const recorder = createArtifactRecorder(storage, CONTEXT);
    await collect(
      captureRunArtifacts(
        recorder,
        stream({
          author: "image-child",
          image: { b64: PNG, mimeType: "image/png", model: "openai/gpt-image-1" },
        }),
      ),
    );
    expect(storage.rowsWritten[0]?.model).toBe("openai/gpt-image-1");
  });

  it("leaves the model out when the producer could not name one", async () => {
    // An MCP tool's picture and a remote agent's arrive with no model at all.
    // Empty is the true answer; a fallback would be a guess presented as a fact.
    const storage = fakeStorage();
    const recorder = createArtifactRecorder(storage, CONTEXT);
    await collect(
      captureRunArtifacts(
        recorder,
        stream(
          { image: { b64: PNG, mimeType: "image/png", prompt: "Returned by render_chart" } },
          { file: { b64: DOCX, mimeType: "application/pdf", name: "report.pdf", source: "mcp: render_document" } },
        ),
      ),
    );
    expect(storage.rowsWritten.map((row) => row.model)).toEqual([undefined, undefined]);
    expect(storage.rowsWritten[0]).not.toHaveProperty("model");
  });

  it("passes the image through with no key when the write failed, and warns once", async () => {
    // Silent loss is the bug, not the failure: the picture is still shown, and
    // the reader is told it was not kept.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const storage = fakeStorage({ putFails: true });
    const recorder = createArtifactRecorder(storage, CONTEXT);
    const out = await collect(
      captureRunArtifacts(recorder, stream({ image: { b64: PNG, mimeType: "image/png" } })),
    );
    expect(out[0]?.image).toEqual({ b64: PNG, mimeType: "image/png" });
    expect(out[1]?.warning).toContain("could not be stored");
  });

  it("names the category of failure, so a reader knows where to look", async () => {
    // The first real failure was a policy granting PutObject on the old prefix
    // while the code had moved to a new one. "Could not be stored" alone sent
    // that to the logs and nowhere else.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const denied = Object.assign(new Error("User is not authorized to perform: s3:PutObject"), {
      name: "AccessDenied",
    });
    const storage = fakeStorage({ putFails: true, error: denied });
    const recorder = createArtifactRecorder(storage, CONTEXT);
    const out = await collect(
      captureRunArtifacts(recorder, stream({ image: { b64: PNG, mimeType: "image/png" } })),
    );
    const warning = out.find((c) => c.warning)?.warning ?? "";
    expect(warning).toContain("storage permissions do not allow it");
    // Never the provider's own words: they name the bucket, the key and often
    // the role, which is deployment shape nobody in a chat should be shown.
    expect(warning).not.toContain("s3:PutObject");
    expect(warning).not.toContain("User is not authorized");
  });

  it("says nothing about the cause when it cannot classify one", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const storage = fakeStorage({ putFails: true, error: new Error("connection reset") });
    const recorder = createArtifactRecorder(storage, CONTEXT);
    const out = await collect(
      captureRunArtifacts(recorder, stream({ image: { b64: PNG, mimeType: "image/png" } })),
    );
    const warning = out.find((c) => c.warning)?.warning ?? "";
    expect(warning).toContain("could not be stored, so it is shown here");
    expect(warning).not.toContain("connection reset");
  });

  it("tells the reader once, with the run's true total", async () => {
    // A run that lost three pictures has one thing to say, not three — and it
    // has to say "three". Warning on the first failure would report "one file"
    // and then absorb the rest into the same one-shot flag.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const storage = fakeStorage({ rowFails: true });
    const recorder = createArtifactRecorder(storage, CONTEXT);
    const out = await collect(
      captureRunArtifacts(
        recorder,
        stream(
          { image: { b64: PNG, mimeType: "image/png" } },
          { image: { b64: PNG, mimeType: "image/png" } },
          { image: { b64: PNG, mimeType: "image/png" } },
        ),
      ),
    );
    const warnings = out.filter((c) => c.warning);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.warning).toContain("3 files");
  });

  it("reports the loss after the run rather than interrupting it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const storage = fakeStorage({ putFails: true });
    const recorder = createArtifactRecorder(storage, CONTEXT);
    const out = await collect(
      captureRunArtifacts(
        recorder,
        stream({ image: { b64: PNG, mimeType: "image/png" } }, { delta: { content: "done" } }),
      ),
    );
    expect(out.map((c) => (c.warning ? "warning" : c.image ? "image" : "delta"))).toEqual([
      "image",
      "delta",
      "warning",
    ]);
  });

  it("never turns a storage failure into a failed run", async () => {
    // The run drew the picture; losing the copy is worth strictly less than
    // losing the answer.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const storage = fakeStorage({ putFails: true });
    const recorder = createArtifactRecorder(storage, CONTEXT);
    const out = await collect(
      captureRunArtifacts(
        recorder,
        stream({ image: { b64: PNG, mimeType: "image/png" } }, { delta: { content: "done" } }),
      ),
    );
    expect(out.some((c) => c.delta?.content === "done")).toBe(true);
  });

  it("does not report storing that worked — a gain is not a warning", async () => {
    const storage = fakeStorage();
    const recorder = createArtifactRecorder(storage, CONTEXT);
    const out = await collect(
      captureRunArtifacts(recorder, stream({ image: { b64: PNG, mimeType: "image/png" } })),
    );
    expect(out.filter((c) => c.warning)).toHaveLength(0);
  });

  it("leaves chunks that carry no bytes exactly as they were", async () => {
    const storage = fakeStorage();
    const recorder = createArtifactRecorder(storage, CONTEXT);
    const passthrough = { delta: { content: "hello" }, usage: undefined };
    const [chunk] = await collect(captureRunArtifacts(recorder, stream(passthrough)));
    expect(chunk).toBe(passthrough);
    expect(storage.rowsWritten).toHaveLength(0);
  });

  it("leaves a file that was already stripped alone", async () => {
    const storage = fakeStorage();
    const recorder = createArtifactRecorder(storage, CONTEXT);
    const already = { file: { mimeType: "application/pdf", name: "r.pdf", source: "mcp", key: "artifacts/document/x.pdf" } };
    const [chunk] = await collect(captureRunArtifacts(recorder, stream(already)));
    expect(chunk).toBe(already);
    expect(storage.rowsWritten).toHaveLength(0);
  });
});

/**
 * An artifact is what a run *produced*. `FetchUrl` brings back pictures the run
 * only read — and once a run can fetch its caller's avatar to redraw it, keeping
 * those files a person's own gallery with the photo they started from.
 */
describe("a picture the run read rather than made", () => {
  it("is delivered but not kept", async () => {
    const storage = fakeStorage();
    const recorder = createArtifactRecorder(storage, CONTEXT);

    const chunks: EngineChunk[] = [];
    for await (const chunk of captureRunArtifacts(
      recorder,
      (async function* () {
        yield {
          image: { b64: "YWJj", mimeType: "image/png", prompt: "Returned by FetchUrl", fetched: true },
        };
      })(),
    )) {
      chunks.push(chunk);
    }

    expect(storage.rowsWritten).toEqual([]);
    expect(storage.puts).toEqual([]);
    // The reader still sees it and the model can still edit it — the bytes ride
    // through untouched, with no artifact reference attached.
    expect(chunks[0]?.image?.b64).toBe("YWJj");
    expect(chunks[0]?.image?.artifactId).toBeUndefined();
  });

  it("still keeps what the same run went on to make", async () => {
    // The case this exists for: fetch the avatar, redraw it, keep the drawing.
    const storage = fakeStorage();
    const recorder = createArtifactRecorder(storage, CONTEXT);

    for await (const _ of captureRunArtifacts(
      recorder,
      (async function* () {
        yield { image: { b64: "c3Jj", mimeType: "image/png", fetched: true } };
        yield { image: { b64: "ZHJhdw==", mimeType: "image/png", prompt: "a crude doodle" } };
      })(),
    )) {
      // drained
    }

    expect(storage.rowsWritten).toHaveLength(1);
    expect(storage.rowsWritten[0]?.prompt).toBe("a crude doodle");
  });
});
