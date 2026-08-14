/**
 * Turning what a run produced into something a reader can fetch.
 *
 * Three states, and the difference between them is the whole point: an address,
 * a sentence saying why there is none, and deliberate silence when something
 * else has already said it. Getting the third wrong is how a reader hears the
 * same failure twice; getting the second wrong is how they hear nothing at all,
 * which is the state this module was written to end.
 */

import { describe, expect, it, vi } from "vitest";
import {
  filesNotKeptWarning,
  resolveProducedFile,
  resolveProducedFiles,
  withAddressedFiles,
  type ProducedFileRef,
} from "@/application/artifact/producedFiles";
import type { SignObjectUrl } from "@/domain/artifact/objectStore";
import type { EngineChunk } from "@/domain/llm/types";

const TTL = 900;

function ref(overrides: Partial<ProducedFileRef> = {}): ProducedFileRef {
  return {
    name: "report.docx",
    mimeType: "application/msword",
    byteSize: 2048,
    key: "objects/report.docx",
    ...overrides,
  };
}

const sign = async (key: string, _ttl: number, opts?: { downloadAs?: string }) =>
  `https://signed/${key}?name=${opts?.downloadAs ?? ""}`;

describe("resolveProducedFiles", () => {
  it("addresses a stored file under the name it should be saved as", async () => {
    const { files, warnings } = await resolveProducedFiles([ref()], sign, TTL);
    expect(files).toEqual([
      {
        name: "report.docx",
        mimeType: "application/msword",
        byteSize: 2048,
        url: "https://signed/objects/report.docx?name=report.docx",
      },
    ]);
    expect(warnings).toEqual([]);
  });

  it("says once that a deployment with no storage kept none of them", async () => {
    const { files, warnings } = await resolveProducedFiles([ref(), ref()], undefined, TTL);
    expect(files).toEqual([]);
    // One sentence for the run, not one per file: the reader is learning about
    // the deployment, and hearing it twice tells them nothing more.
    expect(warnings).toEqual([filesNotKeptWarning(2)]);
  });

  it("stays silent about a file the capture already failed on", async () => {
    // Storage is configured and this one has no key, so the recorder yielded its
    // own warning chunk with the provider's reason — better than a bare count.
    const { files, warnings } = await resolveProducedFiles([ref({ key: undefined })], sign, TTL);
    expect(files).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("reports a signature it could not produce rather than offering a dead link", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { files, warnings } = await resolveProducedFiles(
      [ref()],
      async () => {
        throw new Error("kms unavailable");
      },
      TTL,
    );
    expect(files).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("could not be offered");
    error.mockRestore();
  });

  it("has nothing to say about a run that produced no files", async () => {
    expect(await resolveProducedFiles([], undefined, TTL)).toEqual({ files: [], warnings: [] });
  });
});

describe("resolveProducedFile", () => {
  it("answers the same three ways, one file at a time", async () => {
    expect((await resolveProducedFile(ref(), sign, TTL)).file?.url).toContain("objects/report.docx");
    expect((await resolveProducedFile(ref(), undefined, TTL)).warning).toBe(filesNotKeptWarning(1));
    expect(await resolveProducedFile(ref({ key: undefined }), sign, TTL)).toEqual({});
  });
});

describe("withAddressedFiles", () => {
  const stored: EngineChunk = {
    file: {
      name: "report.docx",
      mimeType: "application/msword",
      source: "mcp: render",
      byteSize: 2048,
      key: "objects/report.docx",
      artifactId: "art-1",
    },
  };

  async function drain(
    chunks: EngineChunk[],
    signer: SignObjectUrl | undefined,
  ): Promise<EngineChunk[]> {
    const out: EngineChunk[] = [];
    for await (const chunk of withAddressedFiles(
      (async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      })(),
      signer,
      TTL,
    )) {
      out.push(chunk);
    }
    return out;
  }

  it("swaps the platform's identifiers for an address", async () => {
    const [chunk] = await drain([stored], sign);
    expect(chunk?.file).toEqual({
      name: "report.docx",
      mimeType: "application/msword",
      source: "mcp: render",
      byteSize: 2048,
      url: "https://signed/objects/report.docx?name=report.docx",
    });
    // The object key and artifact row id are this platform's bookkeeping; a
    // caller holding them can do nothing with them.
    expect(chunk?.file).not.toHaveProperty("key");
    expect(chunk?.file).not.toHaveProperty("artifactId");
  });

  it("leaves the bytes alone when this deployment stores nothing", async () => {
    // The bracket's capture is the identity without storage, so the payload is
    // still on the frame and *is* the delivery. Replacing it with "there is
    // nothing to download" would take away the only copy that exists.
    const inline: EngineChunk = {
      file: { name: "a.txt", mimeType: "text/plain", source: "mcp: x", b64: "aGk=" },
    };
    expect(await drain([inline], undefined)).toEqual([inline]);
  });

  it("says why when there is neither an address nor bytes", async () => {
    const bare: EngineChunk = {
      file: { name: "a.txt", mimeType: "text/plain", source: "mcp: x" },
    };
    const out = await drain([bare], undefined);
    expect(out).toEqual([{ warning: filesNotKeptWarning(1) }]);
  });

  it("keeps a child's authorship on the warning it replaces", async () => {
    const authored: EngineChunk = {
      author: "writer",
      file: { name: "a.txt", mimeType: "text/plain", source: "mcp: x" },
    };
    const out = await drain([authored], undefined);
    expect(out[0]).toMatchObject({ author: "writer" });
  });

  it("passes every other chunk through untouched", async () => {
    const others: EngineChunk[] = [{ delta: { content: "hi" } }, { done: true }];
    expect(await drain(others, sign)).toEqual(others);
  });
});
