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

  it("presigns reads in authenticated mode", async () => {
    mocks.getArtifactAccessMode.mockResolvedValue("authenticated");
    mocks.getSignedUrl.mockResolvedValue("https://signed.example.com/object");

    await expect(
      artifactObjectStore.sign("artifacts/document/id.pdf", 900, { downloadAs: "보고서.pdf" }),
    ).resolves.toBe("https://signed.example.com/object");
    expect(mocks.getSignedUrl).toHaveBeenCalledOnce();
  });

});
