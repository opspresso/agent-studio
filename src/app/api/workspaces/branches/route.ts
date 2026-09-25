import { withMemberAuth } from "@/lib/session";
import { workspaceBranches } from "@/lib/container";
import { apiError, parseName } from "@/app/api/_lib/http";

export type WorkspaceBranchesResponse = Awaited<ReturnType<typeof workspaceBranches>>;
export const GET = withMemberAuth(async (user, request: Request) => {
  try {
    const query = new URL(request.url).searchParams;
    return Response.json(await workspaceBranches(parseName(query.get("agent") ?? ""), user.email, query.get("repository") ?? undefined) satisfies WorkspaceBranchesResponse);
  }
  catch (error) { return apiError(error); }
});
