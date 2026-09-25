import { withMemberAuth } from "@/lib/session";
import { getAudioRuntime } from "@/lib/container";
import { editorBody } from "@/app/api/_lib/body";
import { apiError, invalidRequest } from "@/app/api/_lib/http";
import { sourceReferenceSchema } from "@/app/api/agents/_lib/audioSchemas";

export const POST = withMemberAuth(async (user, request: Request, context: { params: Promise<{ name: string }> }) => {
  const body = await editorBody(request);
  if (body instanceof Response) return body;
  const parsed = sourceReferenceSchema.safeParse(body);
  if (!parsed.success) return invalidRequest(parsed.error);
  try {
    const { name } = await context.params;
    return Response.json(await getAudioRuntime().references.register({ ...parsed.data, agentName: name, userEmail: user.email }), { status: 201 });
  } catch (error) { return apiError(error); }
});
