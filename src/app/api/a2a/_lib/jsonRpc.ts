import { RequestMalformedError } from "@a2a-js/sdk/errors";

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

/** The SDK binds the raw tenant to its context without validating its type. */
export function validateA2aJsonRpcTenant(request: unknown): void {
  if (!isObject(request) || !isObject(request.params)) {
    return;
  }
  const tenant = request.params.tenant;
  if (tenant !== undefined && typeof tenant !== "string") {
    throw new RequestMalformedError("tenant must be a string.");
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
