import type { ZodError } from "zod";
import type { Project } from "@/domain/project/types";
import { statusForError } from "@/application/project/errors";

/** 400 response for a failed zod parse. */
export function invalidRequest(error: ZodError): Response {
  return Response.json({ error: "Invalid request", issues: error.issues }, { status: 400 });
}

/** Map an application error to its HTTP response; unknown errors become 500. */
export function apiError(error: unknown): Response {
  const status = statusForError(error);
  if (status !== null) {
    return Response.json({ error: (error as Error).message }, { status });
  }
  console.error("[projects] unhandled error", error);
  return Response.json({ error: "Internal server error" }, { status: 500 });
}

/**
 * Strip stored Slack credentials before returning a project to clients.
 * The slack field collapses to a configured/enabled summary; secrets are
 * readable only through the masked /slack endpoint.
 */
export function sanitizeProject(project: Project): Omit<Project, "slack"> & {
  slack?: { enabled: boolean; configured: boolean };
} {
  const { slack, ...rest } = project;
  if (!slack) {
    return rest;
  }
  return {
    ...rest,
    slack: { enabled: slack.enabled, configured: Boolean(slack.botToken && slack.signingSecret) },
  };
}
