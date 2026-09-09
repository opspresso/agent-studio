import { withMemberAuth } from "@/lib/session";
import { getAudioRuntime } from "@/lib/container";
import { apiError } from "@/app/api/_lib/http";

export type AudioOptionsResponse = Awaited<ReturnType<ReturnType<typeof getAudioRuntime>["options"]>>;
export const GET = withMemberAuth(async (user, _request: Request, context: { params: Promise<{ name: string }> }) => {
  try {
    const { name } = await context.params;
    return Response.json(await getAudioRuntime().options(name, user.email));
  } catch (error) { return apiError(error); }
});
