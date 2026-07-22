import { QueryCommand, type QueryCommandInput } from "@aws-sdk/lib-dynamodb";
import { getDocumentClient } from "./client";

/**
 * Run a Query and follow `LastEvaluatedKey` until the full result set is
 * collected. A single Query page caps at 1MB, so any list that can exceed that
 * must paginate — otherwise results are silently truncated.
 */
export async function queryAll(
  input: Omit<QueryCommandInput, "ExclusiveStartKey">,
): Promise<Record<string, unknown>[]> {
  const client = getDocumentClient();
  const items: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const page = await client.send(new QueryCommand({ ...input, ExclusiveStartKey: lastKey }));
    for (const item of page.Items ?? []) {
      items.push(item);
    }
    lastKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);
  return items;
}
