import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  getSignedUrl: vi.fn(),
  getArtifactAccessMode: vi.fn(),
  getS3PublicBaseUrl: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = mocks.send;
  },
  PutObjectCommand: class {
    constructor(readonly input: unknown) {}
  },
  GetObjectCommand: class {
    constructor(readonly input: unknown) {}
  },
  DeleteObjectCommand: class {
    constructor(readonly input: unknown) {}
  },
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: mocks.getSignedUrl }));
vi.mock("@/lib/runtime-settings", () => ({
  getArtifactAccessMode: mocks.getArtifactAccessMode,
  getS3PublicBaseUrl: mocks.getS3PublicBaseUrl,
}));

const { artifactObjectStore, artifactPublicUrl, readStoredObject } = await import(
  "@/infrastructure/storage/s3ObjectStore"
);

const savedBucket = process.env.S3_BUCKET_NAME;

it("keeps private files outside generic reads, writes, deletes and URL generation", async () => {
  const key = "source-files/private";
  await expect(artifactObjectStore.read(key, 100)).rejects.toMatchObject({ name: "ObjectNotFoundError" });
  await expect(artifactObjectStore.put({ key, bytes: new Uint8Array([1]), mimeType: "audio/mpeg" })).rejects.toMatchObject({ name: "ObjectNotFoundError" });
  await expect(artifactObjectStore.delete(key)).rejects.toMatchObject({ name: "ObjectNotFoundError" });
  await expect(artifactObjectStore.sign(key, 60)).rejects.toMatchObject({ name: "ObjectNotFoundError" });
  await expect(artifactPublicUrl(key)).rejects.toThrow("No stored object");
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.getSignedUrl).not.toHaveBeenCalled();
});

it("cancels a stalled Node object body and destroys its socket stream", async () => {
  const controller = new AbortController();
  let started!: () => void;
  const reading = new Promise<void>((resolve) => { started = resolve; });
  const body = new Readable({ read() { started(); } });
  mocks.send.mockResolvedValue({ Body: body, ContentType: "audio/mpeg" });
  const result = readStoredObject("shared-artifacts", "source-files/id", 100, controller.signal);
  const rejected = expect(result).rejects.toThrow("worker stopped");
  await reading; controller.abort(new Error("worker stopped"));
  await rejected;
  expect(body.destroyed).toBe(true);
});
const savedRegion = process.env.AWS_REGION;

function streamingBody(chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>) {
  const body = Readable.from(chunks, { objectMode: false, highWaterMark: 1 });
  return Object.assign(body, {
    transformToByteArray: vi.fn(async () => {
      const collected: Uint8Array[] = [];
      for await (const chunk of body) {
        collected.push(chunk);
      }
      return Buffer.concat(collected);
    }),
    // The SDK's Node stream mixin uses this same conversion.
    transformToWebStream: vi.fn(() => Readable.toWeb(body)),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getS3PublicBaseUrl.mockReset().mockResolvedValue(undefined);
  process.env.S3_BUCKET_NAME = "artifact-bucket";
  process.env.AWS_REGION = "ap-northeast-2";
});

afterEach(() => {
  if (savedBucket === undefined) delete process.env.S3_BUCKET_NAME;
  else process.env.S3_BUCKET_NAME = savedBucket;
  if (savedRegion === undefined) delete process.env.AWS_REGION;
  else process.env.AWS_REGION = savedRegion;
});

describe("artifactObjectStore access modes", () => {
  it("reads stored bytes and preserves their content type", async () => {
    const body = streamingBody([Uint8Array.from([1, 2]), Uint8Array.from([3])]);
    mocks.send.mockResolvedValue({
      ContentLength: 3,
      ContentType: "image/png",
      Body: body,
    });

    const result = await artifactObjectStore.read("artifacts/image/id.png", 10);
    expect([...result.bytes]).toEqual([1, 2, 3]);
    expect(result.mimeType).toBe("image/png");
    expect(body.destroyed).toBe(true);
    const command = mocks.send.mock.calls[0]?.[0] as { input: Record<string, string> };
    expect(command.input.Key).toBe("artifacts/image/id.png");
  });

  it("reads a picture's type off its bytes when the header lost it", async () => {
    // What `aws s3 sync` → `mc mirror` leaves on an extensionless `images/<uuid>`
    // key: the generic type. The bytes still say PNG.
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
    mocks.send.mockResolvedValue({
      ContentLength: png.byteLength,
      ContentType: "application/octet-stream",
      Body: streamingBody([png]),
    });
    await expect(artifactObjectStore.read("images/abc", 100)).resolves.toMatchObject({
      mimeType: "image/png",
    });

    // Bytes that are no picture keep the generic type rather than a guess.
    mocks.send.mockResolvedValue({
      ContentLength: 3,
      Body: streamingBody([Uint8Array.from([1, 2, 3])]),
    });
    await expect(artifactObjectStore.read("artifacts/file/x.bin", 100)).resolves.toMatchObject({
      mimeType: "application/octet-stream",
    });
  });

  it("rejects an oversized object before buffering its body", async () => {
    const read = vi.fn();
    const body = streamingBody((function* () {
      read();
      yield new Uint8Array(11);
    })());
    mocks.send.mockResolvedValue({
      ContentLength: 11,
      ContentType: "image/png",
      Body: body,
    });

    await expect(artifactObjectStore.read("artifacts/image/id.png", 10)).rejects.toThrow(
      "exceeds the 10-byte read limit",
    );
    expect(read).not.toHaveBeenCalled();
    expect(body.destroyed).toBe(true);
  });

  it("reads a bounded body whose size S3 did not report", async () => {
    const body = streamingBody([Uint8Array.from([1, 2, 3])]);
    mocks.send.mockResolvedValue({
      ContentType: "image/png",
      Body: body,
    });

    const result = await artifactObjectStore.read("artifacts/image/id.png", 3);
    expect([...result.bytes]).toEqual([1, 2, 3]);
    expect(result.mimeType).toBe("image/png");
    expect(body.destroyed).toBe(true);
  });

  it.each([undefined, 1])("cuts off an oversized body with declared length %s", async (ContentLength) => {
    let produced = 0;
    const body = streamingBody((function* () {
      for (let index = 0; index < 20; index++) {
        produced += 1;
        yield new Uint8Array(6);
      }
    })());
    mocks.send.mockResolvedValue({ ContentLength, Body: body });

    await expect(artifactObjectStore.read("artifacts/file/id.bin", 10)).rejects.toThrow(
      "exceeds the 10-byte read limit",
    );

    expect(produced).toBeGreaterThanOrEqual(2);
    expect(produced).toBeLessThan(20);
    expect(body.destroyed).toBe(true);
  });

  it("releases the body and preserves a read failure", async () => {
    const error = new Error("object connection reset");
    const body = streamingBody((async function* () {
      yield Uint8Array.from([1]);
      throw error;
    })());
    mocks.send.mockResolvedValue({ ContentLength: 3, Body: body });

    await expect(artifactObjectStore.read("artifacts/file/id.bin", 10)).rejects.toBe(error);

    expect(body.destroyed).toBe(true);
  });

  it("cancels and unlocks an oversized SDK Web Stream body", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(6));
      },
      cancel,
    }, { highWaterMark: 0 });
    const body = Object.assign(stream, {
      transformToWebStream: () => stream,
    });
    mocks.send.mockResolvedValue({ ContentLength: 1, Body: body });

    await expect(artifactObjectStore.read("artifacts/file/id.bin", 10)).rejects.toThrow(
      "exceeds the 10-byte read limit",
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("rejects a response with no body", async () => {
    mocks.send.mockResolvedValue({ ContentLength: 0 });

    await expect(artifactObjectStore.read("artifacts/file/id.bin", 10)).rejects.toThrow(
      "stored object has no body",
    );
  });

  it("returns an encoded direct S3 URL in public mode without presigning", async () => {
    mocks.getArtifactAccessMode.mockResolvedValue("public");

    await expect(artifactObjectStore.sign("artifacts/image/a b.png", 900)).resolves.toBe(
      "https://artifact-bucket.s3.ap-northeast-2.amazonaws.com/artifacts/image/a%20b.png",
    );
    expect(mocks.getSignedUrl).not.toHaveBeenCalled();
    expect(await artifactPublicUrl("artifacts/문서/a b.pdf")).toContain(
      "artifacts/%EB%AC%B8%EC%84%9C/a%20b.pdf",
    );
  });

  it("uses the saved public object URL for direct links", async () => {
    mocks.getArtifactAccessMode.mockResolvedValue("public");
    mocks.getS3PublicBaseUrl.mockResolvedValue("https://objects.example.com/bucket/");
    await expect(artifactObjectStore.sign("artifacts/image/a b.png", 900)).resolves.toBe(
      "https://objects.example.com/bucket/artifacts/image/a%20b.png",
    );
  });

  it("presigns a download in public mode, because S3 refuses response overrides on an anonymous GET", async () => {
    mocks.getArtifactAccessMode.mockResolvedValue("public");
    mocks.getSignedUrl.mockResolvedValue("https://signed.example.com/object");

    await expect(
      artifactObjectStore.sign("artifacts/document/id.pdf", 900, { downloadAs: "보고서.pdf" }),
    ).resolves.toBe("https://signed.example.com/object");
    const command = mocks.getSignedUrl.mock.calls[0]?.[1] as { input: Record<string, string> };
    expect(command.input.ResponseContentDisposition).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent("보고서.pdf")}`,
    );
  });

  it("presigns reads in authenticated mode", async () => {
    mocks.getArtifactAccessMode.mockResolvedValue("authenticated");
    mocks.getSignedUrl.mockResolvedValue("https://signed.example.com/object");

    await expect(
      artifactObjectStore.sign("artifacts/document/id.pdf", 900, { downloadAs: "보고서.pdf" }),
    ).resolves.toBe("https://signed.example.com/object");
    expect(mocks.getSignedUrl).toHaveBeenCalledOnce();
  });

  it("names a missing object with the port's error rather than the SDK's", async () => {
    const { ObjectNotFoundError } = await import("@/domain/artifact/objectStore");
    mocks.send.mockRejectedValue(Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey" }));
    await expect(artifactObjectStore.read("artifacts/image/gone.png", 10)).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
    mocks.send.mockRejectedValue(Object.assign(new Error("denied"), { name: "AccessDenied" }));
    await expect(artifactObjectStore.read("artifacts/image/gone.png", 10)).rejects.toThrow("denied");
  });
});
