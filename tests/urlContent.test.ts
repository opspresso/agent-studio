import { describe, expect, it } from "vitest";
import { MAX_FETCH_BYTES, MAX_FETCHED_TEXT_CHARS, readUrlContent } from "@/application/llm/urlContent";
import { HttpResourceError, type HttpResource } from "@/domain/net/httpResource";
import { DocumentExtractionError } from "@/domain/llm/documentExtractor";
import { MAX_IMAGE_BYTES } from "@/domain/llm/imageLimits";
import { MAX_DOCUMENT_CHARS } from "@/domain/llm/documentLimits";
import { documentExtractor } from "@/infrastructure/llm/documentExtractor";

/**
 * The use case runs on two ports and nothing else, so these need no network and
 * no parser — which is the point of the ports.
 */
function ports(resource: Partial<HttpResource> & { throws?: Error }) {
  const asked: Array<{ url: string; accept: string; maxBytes: number }> = [];
  return {
    asked,
    ports: {
      http: {
        async read(input: { url: string; accept: string; maxBytes: number }) {
          asked.push(input);
          if (resource.throws) {
            throw resource.throws;
          }
          return {
            bytes: resource.bytes ?? Buffer.from(""),
            mimeType: resource.mimeType ?? "text/plain",
            ...(resource.charset ? { charset: resource.charset } : {}),
            finalUrl: resource.finalUrl ?? input.url,
          };
        },
      },
      // The real extractor: this is the seam the design is about — a fetched
      // page and an attached file become text through one owner.
      documents: documentExtractor,
    },
  };
}

describe("reading a URL", () => {
  it("asks for at most the fetch cap", async () => {
    const { ports: p, asked } = ports({ bytes: Buffer.from("hi") });
    await readUrlContent(p, "https://example.test/a.txt");
    expect(asked[0]?.maxBytes).toBe(MAX_FETCH_BYTES);
  });

  it("keeps far more text than an attachment would", async () => {
    // The asymmetry is deliberate and documented: an attachment enters the
    // persisted turn and model context; this is a transient tool result.
    expect(MAX_FETCHED_TEXT_CHARS).toBeGreaterThan(MAX_DOCUMENT_CHARS);
  });

  it("returns plain text as it was", async () => {
    const { ports: p } = ports({ bytes: Buffer.from("just words"), mimeType: "text/plain" });
    const read = await readUrlContent(p, "https://example.test/a.txt");
    expect(read.text).toBe("just words");
    expect(read.image).toBeUndefined();
  });

  it("takes the markup off a page", async () => {
    const { ports: p } = ports({
      bytes: Buffer.from("<title>T</title><body><script>x()</script><p>Body.</p></body>"),
      mimeType: "text/html",
    });
    const read = await readUrlContent(p, "https://example.test/page");
    expect(read.text).toBe("T\n\nBody.");
  });

  it("follows the charset the response declared", async () => {
    // A remote server is not something the caller can go and re-save, which is
    // the whole reason this argument exists.
    const eucKr = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]);
    const { ports: p } = ports({
      bytes: Buffer.concat([Buffer.from("<p>"), eucKr, Buffer.from("</p>")]),
      mimeType: "text/html",
      charset: "euc-kr",
    });
    expect((await readUrlContent(p, "https://example.test/k")).text).toBe("한글");
  });

  it("reports what it left out, in the document's own units", async () => {
    const { ports: p } = ports({
      bytes: Buffer.from("x".repeat(MAX_FETCHED_TEXT_CHARS + 500)),
      mimeType: "text/plain",
    });
    const read = await readUrlContent(p, "https://example.test/big.txt");
    expect(read.text).toHaveLength(MAX_FETCHED_TEXT_CHARS);
    expect(read.note).toContain("characters");
  });

  it("hands back a picture instead of text", async () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const { ports: p } = ports({ bytes: png, mimeType: "image/png" });
    const read = await readUrlContent(p, "https://example.test/a.png");
    expect(read.image).toEqual({ b64: png.toString("base64"), mimeType: "image/png" });
    expect(read.text).toBe("");
  });

  it("refuses an image the provider would not take, by the provider's own cap", async () => {
    const { ports: p } = ports({
      bytes: Buffer.alloc(MAX_IMAGE_BYTES + 1),
      mimeType: "image/png",
    });
    await expect(readUrlContent(p, "https://example.test/big.png")).rejects.toBeInstanceOf(
      HttpResourceError,
    );
  });

  it("refuses an image format that cannot be read here", async () => {
    const { ports: p } = ports({ bytes: Buffer.from("x"), mimeType: "image/tiff" });
    await expect(readUrlContent(p, "https://example.test/a.tiff")).rejects.toThrow(/image/);
  });

  it("refuses a type that is neither text nor a picture", async () => {
    const { ports: p } = ports({ bytes: Buffer.from("PK"), mimeType: "application/zip" });
    await expect(readUrlContent(p, "https://example.test/a.zip")).rejects.toBeInstanceOf(
      HttpResourceError,
    );
  });

  it("names the file from the address, so a mislabelled PDF is still read", async () => {
    // Servers label PDFs `application/octet-stream` often enough that the type
    // alone would lose them.
    const { ports: p, asked } = ports({
      bytes: Buffer.from("%PDF-1.4 not really"),
      mimeType: "application/octet-stream",
      finalUrl: "https://example.test/files/report.pdf",
    });
    // The extractor is reached (and fails on the bogus body), which is what
    // proves the name decided rather than the type.
    await expect(readUrlContent(p, "https://example.test/files/report.pdf")).rejects.toBeInstanceOf(
      HttpResourceError,
    );
    expect(asked).toHaveLength(1);
  });

  it("passes the boundary's own refusal through unchanged", async () => {
    // Already generalised by the adapter — nothing here may make it specific.
    const { ports: p } = ports({ throws: new HttpResourceError("that address is not reachable from here") });
    await expect(readUrlContent(p, "http://10.0.0.1/")).rejects.toThrow(
      "that address is not reachable from here",
    );
  });

  it("turns an extraction failure into a sentence a model can act on", async () => {
    const { ports: p } = ports({ bytes: Buffer.from("%PDF-1.4 broken"), mimeType: "application/pdf" });
    const error = await readUrlContent(p, "https://example.test/a.pdf").catch((e) => e);
    expect(error).toBeInstanceOf(HttpResourceError);
    expect(error).not.toBeInstanceOf(DocumentExtractionError);
  });
});
