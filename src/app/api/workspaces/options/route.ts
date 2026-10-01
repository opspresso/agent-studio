import { withAuth } from "@/lib/session";
import { workspaceOptions } from "@/lib/container";
import { apiError } from "@/app/api/_lib/http";

export type WorkspaceOptionsResponse = Awaited<ReturnType<typeof workspaceOptions>>;
export const GET = withAuth(async user => {
  try { return Response.json(await workspaceOptions(user.email) satisfies WorkspaceOptionsResponse); }
  catch (error) { return apiError(error); }
});
