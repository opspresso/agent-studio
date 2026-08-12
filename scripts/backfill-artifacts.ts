/**
 * Give the images stored before artifact rows existed an inventory.
 *
 * Objects under the old `images/<uuid>.<ext>` layout are named by exactly one
 * thing: the chat message that happened to be open when they were made. Nothing
 * lists them, and nothing can delete them — the gallery would show a person's
 * work from today and answer "why can I not remove yesterday's?" with silence.
 * This walks the chats and writes the missing rows.
 *
 * Write-only and idempotent: a second run re-derives the same artifact id from
 * the same object key and overwrites the same row, so it is safe to re-run and
 * safe to run long after the deploy. It never touches an object, and never
 * touches the chat message it read.
 *
 *   pnpm tsx --env-file=.env.local scripts/backfill-artifacts.ts [--apply]
 *
 * Without `--apply` it only reports what it would write.
 */

import { createHash } from "node:crypto";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";

process.env.STAGE ??= "local";

const apply = process.argv.includes("--apply");

/**
 * A stable id for an object that already exists.
 *
 * Derived from the key rather than random, which is what makes a re-run
 * overwrite instead of duplicate. The key stays as it was found: these objects
 * are not moved to the `artifacts/` layout, because moving them would break
 * every chat row that names them.
 */
function idForKey(key: string): string {
  const digest = createHash("sha256").update(key).digest("hex");
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    digest.slice(12, 16),
    digest.slice(16, 20),
    digest.slice(20, 32),
  ].join("-");
}

function mimeForKey(key: string): string {
  const extension = key.split(".").pop()?.toLowerCase();
  return extension === "jpg" || extension === "jpeg"
    ? "image/jpeg"
    : extension === "webp"
      ? "image/webp"
      : extension === "gif"
        ? "image/gif"
        : "image/png";
}

type Db = typeof import("@/infrastructure/db/client");

/** Every chat in the table. A Scan, because chats are keyed by id, not listed. */
async function* allChats(
  { getDocumentClient, getTableName }: Db,
): AsyncGenerator<{ chatId: string; ownerEmail: string; projectName?: string }> {
  const client = getDocumentClient();
  let lastKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(
      new ScanCommand({
        TableName: getTableName(),
        FilterExpression: "entityType = :type",
        // The value `chatRepository` writes. Not "CHAT" — entity names in this
        // table are not uniformly cased, so this is copied, not guessed.
        ExpressionAttributeValues: { ":type": "Chat" },
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of result.Items ?? []) {
      yield {
        chatId: String(item.chatId ?? ""),
        ownerEmail: String(item.ownerEmail ?? ""),
        ...(item.projectName ? { projectName: String(item.projectName) } : {}),
      };
    }
    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);
}

async function main() {
  // Imported here rather than at module scope: this file compiles to CJS, where
  // a top-level await is not available.
  const db = await import("@/infrastructure/db/client");
  const { artifactRepository } = await import(
    "@/infrastructure/db/repositories/artifactRepository"
  );
  const { chatRepository } = await import("@/infrastructure/db/repositories/chatRepository");

  let chats = 0;
  let found = 0;
  let written = 0;
  let skipped = 0;

  for await (const chat of allChats(db)) {
    chats += 1;
    if (!chat.projectName || !chat.ownerEmail) {
      // A chat with no project has nowhere to file its output, and one with no
      // owner has nobody to file it for. Both predate the current shape.
      continue;
    }
    const messages = await chatRepository.listMessages(chat.chatId);
    for (const message of messages) {
      const images = (message as { images?: Array<{ key?: string; url?: string; prompt?: string }> })
        .images;
      for (const image of images ?? []) {
        // Legacy public-URL rows are left alone: the object behind one is
        // already reachable by anyone holding the link, so a row promising a
        // delete button that cannot take that back would be a lie.
        if (!image.key) {
          continue;
        }
        found += 1;
        const artifactId = idForKey(image.key);
        if (await artifactRepository.get(artifactId)) {
          skipped += 1;
          continue;
        }
        if (!apply) {
          continue;
        }
        await artifactRepository.put({
          artifactId,
          kind: "image",
          source: message.role === "user" ? "attachment" : "generated",
          key: image.key,
          mimeType: mimeForKey(image.key),
          byteSize: 0, // Unknown without a HEAD; the gallery shows what it has.
          projectName: chat.projectName,
          versionName: "",
          actor: { kind: "user", id: chat.ownerEmail },
          ...(image.prompt ? { prompt: image.prompt } : {}),
          createdAt: message.createdAt,
        });
        written += 1;
      }
    }
  }

  console.log(
    `${apply ? "Wrote" : "Would write"} ${apply ? written : found - skipped} artifact rows ` +
      `(${chats} chats, ${found} stored images, ${skipped} already had rows).`,
  );
  if (!apply) {
    console.log("Dry run — pass --apply to write.");
  }
}

main().catch((error) => {
  console.error("BACKFILL FAILED:", error);
  process.exit(1);
});
