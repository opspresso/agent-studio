import { describe, expect, it } from "vitest";
import {
  a2aJsonParseError,
  withRequiredA2aDefaults,
} from "@/app/api/a2a/_lib/jsonRpc";

describe("A2A JSON-RPC wire defaults", () => {
  it("keeps the required empty ListTasks nextPageToken on the wire", () => {
    expect(
      withRequiredA2aDefaults("ListTasks", {
        jsonrpc: "2.0",
        id: 1,
        result: { tasks: [], pageSize: 50, totalSize: 0 },
      }),
    ).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { tasks: [], pageSize: 50, totalSize: 0, nextPageToken: "" },
    });
  });

  it("does not overwrite a real cursor or alter an error response", () => {
    const page = { result: { nextPageToken: "cursor" } };
    const error = { jsonrpc: "2.0", id: 1, error: { code: -32602 } };
    expect(withRequiredA2aDefaults("ListTasks", page)).toBe(page);
    expect(withRequiredA2aDefaults("ListTasks", error)).toBe(error);
  });

  it("uses the A2A JSON parse error code", () => {
    expect(a2aJsonParseError()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Invalid JSON payload" },
    });
  });
});
