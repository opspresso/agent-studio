import type { ZodError } from "zod";
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
