import { context as otelContext, trace as otelApi, SpanStatusCode } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { Trace, TraceSpan } from "@/domain/trace/types";

/**
 * The OTLP half of trace export — the heavy adapter `withTraceExport` composes
 * behind a deferred import, so the OTEL SDK loads only in a deployment that
 * set an endpoint.
 *
 * Spans are re-emitted from the persisted `Trace`'s own timestamps, so the
 * OTEL timeline matches what the traces page shows. The app's trace id rides
 * along as the `app.trace_id` attribute — OTEL mints its own ids, and the
 * attribute is what correlates a collector's view back to `/traces`.
 */

export interface OtelExportConfig {
  /** OTLP HTTP base endpoint; `/v1/traces` is appended when absent. */
  endpoint: string;
  headers?: Record<string, string>;
  serviceName: string;
}

function tracesUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, "");
  return trimmed.endsWith("/v1/traces") ? trimmed : `${trimmed}/v1/traces`;
}

function spanAttributes(span: TraceSpan): Record<string, string> {
  return {
    "app.span.kind": span.kind,
    ...(span.author ? { "app.span.author": span.author } : {}),
  };
}

export function createOtelTraceExport(config: OtelExportConfig): (trace: Trace) => void {
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ "service.name": config.serviceName }),
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: tracesUrl(config.endpoint), headers: config.headers }),
      ),
    ],
  });
  const tracer = provider.getTracer("agent-studio");

  return (trace: Trace) => {
    const root = tracer.startSpan(`${trace.projectType} ${trace.projectName}`, {
      startTime: new Date(trace.startedAt),
      attributes: {
        "app.trace_id": trace.traceId,
        "app.project": trace.projectName,
        "app.version": trace.versionName,
        "app.project_type": trace.projectType,
        "app.status": trace.status,
        ...(trace.actor ? { "app.actor": `${trace.actor.kind}:${trace.actor.id}` } : {}),
        ...(trace.spansDropped ? { "app.spans_dropped": trace.spansDropped } : {}),
      },
    });
    const rootContext = otelApi.setSpan(otelContext.active(), root);
    for (const span of trace.spans) {
      const child = tracer.startSpan(
        span.name,
        { startTime: new Date(span.startedAt), attributes: spanAttributes(span) },
        rootContext,
      );
      if (span.status === "error") {
        child.setStatus({ code: SpanStatusCode.ERROR });
      }
      child.end(new Date(span.endedAt));
    }
    if (trace.status === "failed") {
      root.setStatus({ code: SpanStatusCode.ERROR, message: trace.error });
    }
    root.end(new Date(trace.endedAt));
  };
}
