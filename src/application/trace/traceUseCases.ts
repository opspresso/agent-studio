import type { ProjectRepository } from "@/domain/project/repository";
import type { ListTracesOptions, TraceRepository } from "@/domain/trace/repository";
import type { Trace } from "@/domain/trace/types";
import { NotFoundError } from "@/application/errors";
import { assertProjectWritable } from "@/application/project/projectUseCases";

export interface TraceReadDeps {
  traces: TraceRepository;
  projects: ProjectRepository;
}

/**
 * A project's recent traces. Traces hold other users' runtime inputs and
 * outputs, so unlike the shared project catalog they are readable only by the
 * owner and by admins — the read asserts that before touching the store.
 */
export async function listProjectTraces(
  deps: TraceReadDeps,
  projectName: string,
  userEmail: string,
  options?: ListTracesOptions,
): Promise<Trace[]> {
  await assertProjectWritable(deps.projects, projectName, userEmail);
  return deps.traces.listByProject(projectName, options);
}

/**
 * One trace, authorized like the list. Which project a trace belongs to is the
 * trace's own record: a caller authorized for one project must not read
 * another's by guessing ids, so a trace stored under a different project is the
 * same answer as no trace at all.
 */
export async function getProjectTrace(
  deps: TraceReadDeps,
  projectName: string,
  traceId: string,
  userEmail: string,
): Promise<Trace> {
  await assertProjectWritable(deps.projects, projectName, userEmail);
  const trace = await deps.traces.get(traceId);
  if (!trace || trace.projectName !== projectName) {
    throw new NotFoundError("Trace not found");
  }
  return trace;
}

/**
 * The slice bound to its repositories, composed once by the composition root.
 * The free functions above stay exported for application modules that already
 * hold a repository; a route takes this object.
 */
export interface TraceUseCases {
  list(projectName: string, userEmail: string, options?: ListTracesOptions): Promise<Trace[]>;
  get(projectName: string, traceId: string, userEmail: string): Promise<Trace>;
}

export function createTraceUseCases(deps: TraceReadDeps): TraceUseCases {
  return {
    list: (projectName, userEmail, options) =>
      listProjectTraces(deps, projectName, userEmail, options),
    get: (projectName, traceId, userEmail) =>
      getProjectTrace(deps, projectName, traceId, userEmail),
  };
}
