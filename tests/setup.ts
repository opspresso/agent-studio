import { vi } from "vitest";

/**
 * No unit test reaches AWS.
 *
 * `vitest.config.ts` loads this before every test file, so the default DynamoDB
 * document client is a stub that answers every command with an empty result.
 * Repository integration is covered by `scripts/integration-check.ts` against a
 * local table, outside vitest — nothing under `tests/` is meant to open a
 * connection.
 *
 * It is here rather than in each file because forgetting it does not fail
 * loudly. A use case that quietly grew a settings read — `assertProjectWritable`
 * consulting the admin list is the one that did — turns an unrelated test into
 * a hang on an AWS call or a credentials error far from the cause, and six test
 * files had each pasted the same defensive mock in response. The boundary is
 * the client, so the default belongs on the client.
 *
 * A file that needs to observe or drive the DynamoDB calls still declares its
 * own `vi.mock("@/infrastructure/db/client", …)`; a file-level mock replaces
 * this one.
 */
vi.mock("@/infrastructure/db/client", () => ({
  getDocumentClient: () => ({ send: async () => ({}) }),
  getTableName: () => "test-table",
}));
