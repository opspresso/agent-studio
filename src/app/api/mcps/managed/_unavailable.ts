/**
 * The one answer for "this deployment cannot start containers".
 *
 * Every managed route needs it and every managed route said it for itself,
 * which is how a message ends up phrased three ways.
 */
export function managedMcpUnavailable(): Response {
  return Response.json(
    { error: "This deployment is not configured to run managed MCP servers." },
    { status: 503 },
  );
}
