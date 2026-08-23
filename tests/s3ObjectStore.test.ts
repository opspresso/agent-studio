import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  getSignedUrl: vi.fn(),
  getArtifactAccessMode: vi.fn(),
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
}));

const { artifactObjectStore, artifactPublicUrl } = await import(
  "@/infrastructure/storage/s3ObjectStore"
);

const savedBucket = process.env.S3_BUCKET_NAME;
const savedRegion = process.env.AWS_REGION;

beforeEach(() => {
  vi.clearAllMocks();
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
    const transformToByteArray = vi.fn().mockResolvedValue(Uint8Array.from([1, 2, 3]));
    mocks.send.mockResolvedValue({
      ContentLength: 3,
      ContentType: "image/png",
      Body: { transformToByteArray },
    });

    await expect(artifactObjectStore.read("artifacts/image/id.png", 10)).resolves.toEqual({
      bytes: Uint8Array.from([1, 2, 3]),
      mimeType: "image/png",
    });
    expect(transformToByteArray).toHaveBeenCalledOnce();
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
      Body: { transformToByteArray: vi.fn().mockResolvedValue(png) },
    });
    await expect(artifactObjectStore.read("images/abc", 100)).resolves.toMatchObject({
      mimeType: "image/png",
    });

    // Bytes that are no picture keep the generic type rather than a guess.
    mocks.send.mockResolvedValue({
      ContentLength: 3,
      Body: { transformToByteArray: vi.fn().mockResolvedValue(Uint8Array.from([1, 2, 3])) },
    });
    await expect(artifactObjectStore.read("artifacts/file/x.bin", 100)).resolves.toMatchObject({
      mimeType: "application/octet-stream",
    });
  });

  it("rejects an oversized object before buffering its body", async () => {
    const transformToByteArray = vi.fn();
    mocks.send.mockResolvedValue({
      ContentLength: 11,
      ContentType: "image/png",
      Body: { transformToByteArray },
    });

    await expect(artifactObjectStore.read("artifacts/image/id.png", 10)).rejects.toThrow(
      "exceeds the 10-byte read limit",
    );
    expect(transformToByteArray).not.toHaveBeenCalled();
  });

  it("does not buffer a body whose size S3 did not report", async () => {
    const transformToByteArray = vi.fn();
    mocks.send.mockResolvedValue({
      ContentType: "image/png",
      Body: { transformToByteArray },
    });

    await expect(artifactObjectStore.read("artifacts/image/id.png", 10)).rejects.toThrow(
      "has no content length",
    );
    expect(transformToByteArray).not.toHaveBeenCalled();
  });

  it("returns an encoded direct S3 URL in public mode without presigning", async () => {
    mocks.getArtifactAccessMode.mockResolvedValue("public");

    await expect(artifactObjectStore.sign("artifacts/image/a b.png", 900)).resolves.toBe(
      "https://artifact-bucket.s3.ap-northeast-2.amazonaws.com/artifacts/image/a%20b.png",
    );
    expect(mocks.getSignedUrl).not.toHaveBeenCalled();
    expect(artifactPublicUrl("artifacts/문서/a b.pdf")).toContain(
      "artifacts/%EB%AC%B8%EC%84%9C/a%20b.pdf",
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
