import { randomUUID } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config } from "@/lib/config";

let s3Client: S3Client | undefined;

function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({ region: config.awsRegion });
  }
  return s3Client;
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export function isImageStoreConfigured(): boolean {
  return config.imageBucketName !== undefined;
}

/** Upload a generated image to the public-read bucket and return its public URL. */
export async function storeImage(image: { b64: string; mimeType: string }): Promise<string> {
  const bucket = config.imageBucketName;
  if (!bucket) {
    throw new Error("S3_BUCKET_NAME not configured");
  }
  const extension = EXTENSIONS[image.mimeType] ?? "png";
  const key = `images/${randomUUID()}.${extension}`;
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: Buffer.from(image.b64, "base64"),
      ContentType: image.mimeType,
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );
  return `https://${bucket}.s3.${config.awsRegion}.amazonaws.com/${key}`;
}
