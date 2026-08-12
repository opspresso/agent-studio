/**
 * Point a chat's legacy image URLs back at objects that still exist.
 *
 * The rebrand moved the bucket's objects and left these rows behind, so every
 * `url` here names a bucket that is now gone — the pictures 404 in the
 * transcript. The key inside each URL still names the object in the current
 * bucket, so rewriting `{url}` to `{key}` is enough: `resolveImageUrl` signs a
 * key at read time, which is what every row written since does.
 *
 * One-off, and deliberately cautious:
 *  - every object is confirmed present before its row is touched,
 *  - the original `images` array is written to a rollback file first,
 *  - only the `images` attribute is updated, on rows that need it.
 *
 *   pnpm tsx <this> [--apply]
 */

import { ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { writeFileSync } from "node:fs";

process.env.STAGE ??= "alpha";

const apply = process.argv.includes("--apply");
const BUCKET = process.env.S3_BUCKET_NAME ?? "agentdure-static";
const ROLLBACK = "/private/tmp/claude-502/-Users-bruce-workspace-github-com-opspresso-agentdure/b7dbd91a-d6fe-4cae-a929-9199fb12f45f/scratchpad/rollback-chat-images.json";

interface ImageRef {
  key?: string;
  url?: string;
  prompt?: string;
}

/** Only an S3 virtual-hosted address, and only its path. */
function keyFromUrl(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  const match = /^https:\/\/[^/]+\.s3[.-][^/]*amazonaws\.com\/(.+)$/.exec(url);
  const key = match?.[1]?.split("?")[0];
  return key ? decodeURIComponent(key) : undefined;
}

async function main() {
  const { getDocumentClient, getTableName } = await import("@/infrastructure/db/client");
  const client = getDocumentClient();
  const table = getTableName();
  const s3 = new S3Client({ region: process.env.AWS_REGION ?? "ap-northeast-2" });

  const rollback: Array<{ PK: string; SK: string; images: ImageRef[] }> = [];
  let scanned = 0;
  let touched = 0;
  let rewritten = 0;
  let missing = 0;
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await client.send(
      new ScanCommand({
        TableName: table,
        FilterExpression: "entityType = :t AND attribute_exists(images)",
        ExpressionAttributeValues: { ":t": "ChatMessage" },
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of result.Items ?? []) {
      scanned += 1;
      const images = (item.images ?? []) as ImageRef[];
      const next: ImageRef[] = [];
      let changed = false;
      for (const image of images) {
        const key = image.key ?? keyFromUrl(image.url);
        if (image.key || !key) {
          next.push(image);
          continue;
        }
        // Confirm the object before rewriting: a row pointing at a key that is
        // not there is no better than one pointing at a dead URL, and it would
        // be harder to spot afterwards.
        try {
          await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
        } catch {
          missing += 1;
          console.warn(`  object missing, left alone: ${key}`);
          next.push(image);
          continue;
        }
        next.push(image.prompt === undefined ? { key } : { key, prompt: image.prompt });
        changed = true;
        rewritten += 1;
      }
      if (!changed) {
        continue;
      }
      touched += 1;
      rollback.push({ PK: String(item.PK), SK: String(item.SK), images });
      if (!apply) {
        continue;
      }
      await client.send(
        new UpdateCommand({
          TableName: table,
          Key: { PK: item.PK, SK: item.SK },
          UpdateExpression: "SET images = :images",
          ExpressionAttributeValues: { ":images": next },
        }),
      );
    }
    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  if (rollback.length > 0) {
    writeFileSync(ROLLBACK, JSON.stringify(rollback, null, 2));
  }
  console.log(
    `${apply ? "Rewrote" : "Would rewrite"} ${rewritten} image reference(s) on ${touched} message(s) ` +
      `(${scanned} messages with images, ${missing} left alone because the object is gone).`,
  );
  if (rollback.length > 0) {
    console.log(`Rollback written to ${ROLLBACK}`);
  }
  if (!apply) {
    console.log("Dry run — pass --apply to write.");
  }
}

main().catch((error) => {
  console.error("RESTORE FAILED:", error);
  process.exit(1);
});
