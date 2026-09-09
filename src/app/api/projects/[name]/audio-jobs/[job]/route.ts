import { withMemberAuth } from "@/lib/session";
import { getAudioRuntime } from "@/lib/container";
import { editorBody } from "@/app/api/_lib/body";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { audioJobActionSchema } from "@/app/api/projects/_lib/audioSchemas";

type Context = { params: Promise<{ name: string; job: string }> };

export const GET = withMemberAuth(async (user, _request: Request, context: Context) => {
  try {
    const { name, job } = await context.params;
    return Response.json(await getAudioRuntime().jobs.get(name, job, user.email));
  } catch (error) { return apiError(error); }
});

export const POST = withMemberAuth(async (user, request: Request, context: Context) => {
  const body = await editorBody(request);
  if (body instanceof Response) return body;
  const parsed = audioJobActionSchema.safeParse(body);
  if (!parsed.success) return invalidRequest(parsed.error);
  try {
    const { name, job } = await context.params;
    const jobs = getAudioRuntime().jobs;
    return Response.json(await jobs[parsed.data.action](name, job, user.email, parsed.data.revision));
  } catch (error) { return apiError(error); }
});
