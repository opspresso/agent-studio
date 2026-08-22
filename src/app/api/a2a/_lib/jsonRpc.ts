/**
 * Restore scalar defaults that A2A 1.0 requires on the JSON wire but the
 * protobuf JSON codec omits. The SDK's `ListTasksResponse.toJSON` drops an
 * empty string even though the protocol requires `nextPageToken` on the final
 * page as `""`.
 */
export function withRequiredA2aDefaults(method: unknown, response: unknown): unknown {
  if (method !== "ListTasks" || !isObject(response) || !isObject(response.result)) {
    return response;
  }
  if (Object.hasOwn(response.result, "nextPageToken")) {
    return response;
  }
  return {
    ...response,
    result: { ...response.result, nextPageToken: "" },
  };
}

/** The SDK currently maps `JSON.parse` failures to -32600; A2A 1.0 requires -32700. */
export function a2aJsonParseError(): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32700, message: "Invalid JSON payload" },
  };
}

/** Keep the executor and transport on the same task-store partition. */
export function tenantFromA2aJsonRpcRequest(request: unknown): string | undefined {
  if (!isObject(request) || !isObject(request.params)) {
    return undefined;
  }
  const tenant = request.params.tenant;
  return typeof tenant === "string" && tenant !== "" ? tenant : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
