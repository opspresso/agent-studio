import { randomUUID } from "node:crypto";
import { assertLocalDatabase } from "./local-database";
import type { RunActorKind } from "@/domain/execution/actor";
import type { Trace } from "@/domain/trace/types";
import type { TriggerRun } from "@/domain/trigger/types";

const agentName = "sample-agent";
const databaseUrl = process.env.DATABASE_URL;
if (process.env.STAGE !== "local" || !databaseUrl) {
  throw new Error("This fixture requires STAGE=local and DATABASE_URL");
}
assertLocalDatabase(databaseUrl);

async function main() {
  const { agentRepository } = await import("@/infrastructure/db/repositories/agentRepository");
  const { traceRepository } = await import("@/infrastructure/db/repositories/traceRepository");
  const { triggerRepository } = await import("@/infrastructure/db/repositories/triggerRepository");
  const { closePool } = await import("@/infrastructure/db/client");
  try {
    const agent = await agentRepository.get(agentName);
    if (!agent) throw new Error(`Local agent ${agentName} does not exist`);
    const triggers = await triggerRepository.listByAgent(agentName, 100);
    const webhook = triggers.find(trigger => trigger.kind === "webhook" && trigger.triggerId === "webhook");
    const schedules = triggers.filter(trigger => trigger.kind === "schedule");
    if (!webhook || schedules.length === 0) {
      throw new Error("Local sample agent needs a webhook and at least one schedule");
    }

    const now = Date.now();
    const actors: RunActorKind[] = ["agent-token", "slack", "telegram", "teams"];
    for (const [index, kind] of actors.entries()) {
      const at = new Date(now - (index + 1) * 60_000).toISOString();
      const trace: Trace = {
        traceId: `test-${kind}-${randomUUID()}`,
        agentName,
        actor: { kind, id: "local-history-fixture" },
        status: index === 2 ? "failed" : "completed",
        spans: [],
        warnings: ["LOCAL TEST DATA: no Agent execution or platform delivery occurred"],
        startedAt: at,
        endedAt: at,
        durationMs: 0,
        createdAt: at,
      };
      await traceRepository.put(trace);
    }

    for (const [index, trigger] of [webhook, ...schedules].entries()) {
      const at = new Date(now - (index + 5) * 60_000).toISOString();
      const run: TriggerRun = {
        agentName,
        triggerId: trigger.triggerId,
        runId: `test-${randomUUID()}`,
        status: index === 2 ? "failed" : "succeeded",
        startedAt: at,
        endedAt: at,
        ...(trigger.kind === "schedule" ? { scheduledFor: at } : {}),
        result: "[로컬 테스트 데이터] 이력 화면 확인용 예시입니다. 실제 실행이나 전송은 하지 않았습니다.",
      };
      await triggerRepository.appendRun(run);
    }
    console.log(`Created ${actors.length} test traces and ${1 + schedules.length} test trigger runs for ${agentName}`);
  } finally {
    await closePool();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
