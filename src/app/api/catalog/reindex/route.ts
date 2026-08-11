import { after } from "next/server";
import { reindexCatalog } from "@/application/catalog/reindexCatalog";
import { catalogDeps } from "@/lib/container";
import { config } from "@/lib/config";
import { log } from "@/shared/logger";
import { timingSafeEqualString } from "@/shared/timingSafe";
import { unauthorized } from "@/shared/unauthorized";

/**
 * The catalog tick. A Kubernetes CronJob (or anything able to POST) calls this
 * so a newly registered skill or MCP server becomes discoverable without an
 * admin doing anything. Authentication is the same shared token the schedule
 * scan and the plugins sync use — one CronJob credential per deployment.
 *
 * The reindex runs in the background for the same reason those two do: the tick
 * must return in milliseconds while probing every MCP server and embedding the
 * whole registry takes seconds. Its outcome lands in the log line below.
 *
 * Ticking twice is safe. Keys are derived from the entry, so a second pass
 * writes the same records over the same keys and computes the same leftovers.
 */
export async function POST(request: Request): Promise<Response> {
  const token = config.scheduleScanToken;
  if (!token) {
    return Response.json({ error: "Scan ticking is not configured" }, { status: 503 });
  }
  const presented = request.headers.get("x-scan-token");
  if (!presented || !timingSafeEqualString(presented, token)) {
    log.warn("catalog", "reindex tick refused: wrong or missing token");
    return unauthorized();
  }
  const deps = catalogDeps;
  if (!deps) {
    return Response.json({ error: "VECTOR_BUCKET is not configured" }, { status: 503 });
  }

  after(async () => {
    try {
      const report = await reindexCatalog(deps);
      log.info(
        "catalog",
        `reindex: indexed=${report.indexed} removed=${report.removed}` +
          ` undiscovered=${report.undiscovered.length}` +
          (report.undiscovered.length > 0 ? ` [${report.undiscovered.join(", ")}]` : ""),
      );
    } catch (error) {
      log.error("catalog", "reindex failed", error);
    }
  });
  return Response.json({ started: true });
}
