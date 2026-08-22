import { monitorEventLoopDelay } from "node:perf_hooks";

const NANOSECONDS_PER_SECOND = 1_000_000_000;
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();

function finiteSeconds(nanoseconds: number): number {
  return Number.isFinite(nanoseconds) ? nanoseconds / NANOSECONDS_PER_SECOND : 0;
}

export interface ProcessMetricsSnapshot {
  residentMemoryBytes: number;
  heapTotalBytes: number;
  heapUsedBytes: number;
  externalMemoryBytes: number;
  cpuSecondsTotal: number;
  eventLoopDelayP95Seconds: number;
  eventLoopDelayMaxSeconds: number;
}

export function processMetricsSnapshot(): ProcessMetricsSnapshot {
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  return {
    residentMemoryBytes: memory.rss,
    heapTotalBytes: memory.heapTotal,
    heapUsedBytes: memory.heapUsed,
    externalMemoryBytes: memory.external,
    cpuSecondsTotal: (cpu.user + cpu.system) / 1_000_000,
    eventLoopDelayP95Seconds: finiteSeconds(eventLoopDelay.percentile(95)),
    eventLoopDelayMaxSeconds: finiteSeconds(eventLoopDelay.max),
  };
}
