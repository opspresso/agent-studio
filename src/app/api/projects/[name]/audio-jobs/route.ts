import { randomUUID } from "node:crypto";
import { withMemberAuth } from "@/lib/session";
import { getAudioRuntime } from "@/lib/container";
import { editorBody } from "@/app/api/_lib/body";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { audioJobSchema } from "@/app/api/projects/_lib/audioSchemas";
import type { AudioJobView } from "@/application/audio/audioJobUseCases";

type Context = { params: Promise<{ name: string }> };
export interface AudioJobsResponse { jobs: AudioJobView[]; nextCursor: string | null }

export const GET = withMemberAuth(async (user, request: Request, context: Context) => {
  try {
    const { name } = await context.params;
    const query = new URL(request.url).searchParams;
    const limit = Number(query.get("limit") ?? 20);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return Response.json({ error: "Invalid limit" }, { status: 400 });
    const jobs = await getAudioRuntime().jobs.list(name, user.email, limit, query.get("after") ?? undefined);
    return Response.json({ jobs, nextCursor: jobs.length === limit ? jobs.at(-1)!.id : null } satisfies AudioJobsResponse);
  } catch (error) { return apiError(error); }
});

export const POST = withMemberAuth(async (user, request: Request, context: Context) => {
  const body = await editorBody(request);
  if (body instanceof Response) return body;
  const parsed = audioJobSchema.safeParse(body);
  if (!parsed.success) return invalidRequest(parsed.error);
  try {
    const { name } = await context.params;
    const result = await getAudioRuntime().jobs.submit(name, user.email, parsed.data,
      { occurrence: randomUUID(), actor: { kind: "user", id: user.email } });
    return Response.json(result, { status: result.status === "busy" ? 409 : 202 });
  } catch (error) { return apiError(error); }
});
