import { readinessReport } from "@/lib/container";
import { isShuttingDown } from "@/shared/lifecycle";

/**
 * Readiness probe for the load balancer / orchestrator. Reports whether this
 * instance can serve — downstreams reachable and not draining — as a 200/503.
 * Distinct from /api/health (liveness), which stays 200 regardless of
 * downstream state so the process is not needlessly restarted.
 */
export async function GET(): Promise<Response> {
  if (isShuttingDown()) {
    return Response.json({ ready: false, draining: true }, { status: 503 });
  }
  const report = await readinessReport();
  return Response.json(report, { status: report.ready ? 200 : 503 });
}
