/**
 * Liveness probe for load balancers and container orchestrators.
 * Intentionally unauthenticated and dependency-free: it answers "is the
 * process serving requests", not "are downstreams healthy".
 */
export function GET(): Response {
  return Response.json({ status: "ok" });
}
