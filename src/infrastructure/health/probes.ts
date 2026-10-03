import { readinessSql } from "@/infrastructure/db/client";

/** A low-cost read that confirms the schema, credentials, and connectivity. */
export async function dbReachable(): Promise<void> {
  await readinessSql("SELECT 1 FROM items LIMIT 1");
}
