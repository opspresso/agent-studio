import { withMemberAuth } from "@/lib/session";
import { workspaceBranches } from "@/lib/container";
import { apiError, parseName } from "@/app/api/_lib/http";

export type WorkspaceBranchesResponse = Awaited<ReturnType<typeof workspaceBranches>>;
export const GET = withMemberAuth(async (user, request: Request) => {
  try { return Response.json(await workspaceBranches(parseName(new URL(request.url).searchParams.get("project") ?? ""), user.email) satisfies WorkspaceBranchesResponse); }
  catch (error) { return apiError(error); }
});
