import { Client } from "pg";

/** Validate the address the driver will use, including connection-string overrides. */
export function assertLocalDatabase(connectionString: string, testOnly = false): void {
  let client: Client;
  try {
    client = new Client({ connectionString });
  } catch {
    throw new Error("DATABASE_URL is not a valid PostgreSQL connection string");
  }
  if (!["localhost", "127.0.0.1"].includes(client.host)) {
    throw new Error("Refusing to run against a non-local database");
  }
  if (testOnly && !client.database?.endsWith("_test")) {
    throw new Error("Refusing to run against a database whose name does not end in _test");
  }
}
