import { withMemberAuth } from "@/lib/session";
import { getAudioRuntime } from "@/lib/container";
import { editorBody } from "@/app/api/_lib/body";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { audioConfigSchema } from "@/app/api/agents/_lib/audioSchemas";

export type AudioConfigResponse = Awaited<ReturnType<ReturnType<typeof getAudioRuntime>["configuration"]["get"]>>;
type Context = { params: Promise<{ name: string }> };
export const GET = withMemberAuth(async (user, _request: Request, context: Context) => {
  try {
    return Response.json(await getAudioRuntime().configuration.get((await context.params).name, user.email));
  } catch (error) { return apiError(error); }
});
export const PUT = withMemberAuth(async (user, request: Request, context: Context) => {
  const body = await editorBody(request);
  if (body instanceof Response) return body;
  const parsed = audioConfigSchema.safeParse(body);
  if (!parsed.success) return invalidRequest(parsed.error);
  try {
    const { revision, ...input } = parsed.data;
    return Response.json(await getAudioRuntime().configuration.save((await context.params).name, user.email, input, revision));
  } catch (error) { return apiError(error); }
});
