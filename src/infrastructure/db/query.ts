import { QueryCommand, type QueryCommandInput } from "@aws-sdk/lib-dynamodb";
import { getDocumentClient } from "./client";

/**
 * Run a Query and follow `LastEvaluatedKey` until the full result set is
 * collected. A single Query page caps at 1MB, so any list that can exceed that
 * must paginate — otherwise results are silently truncated.
 *
 * `limit` stops the pagination once that many items are in hand, for the reads
 * whose partition has no natural bound. It is the *read* that has to stop:
 * collecting a partition and slicing the answer bounds what is returned and
 * nothing about what was retained on the way there, which is where the memory
 * goes. A caller that passes one must be able to say what it did with the rest
 * — the rows beyond it are not "no rows".
 */
export async function queryAll(
  input: Omit<QueryCommandInput, "ExclusiveStartKey">,
  limit?: number,
): Promise<Record<string, unknown>[]> {
  const client = getDocumentClient();
  const items: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const remaining = limit === undefined ? undefined : limit - items.length;
    const page = await client.send(
      new QueryCommand({
        ...input,
        ExclusiveStartKey: lastKey,
        ...(remaining === undefined ? {} : { Limit: remaining }),
      }),
    );
    for (const item of page.Items ?? []) {
      items.push(item);
    }
    lastKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey && (limit === undefined || items.length < limit));
  return limit === undefined ? items : items.slice(0, limit);
}
