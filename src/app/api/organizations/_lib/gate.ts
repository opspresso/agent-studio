/**
 * Who may administer one named workspace.
 *
 * Two authorities, both real. A workspace's own admins decide who is in it —
 * that is what the role means. A deployment's operators can too, because
 * otherwise a workspace whose last admin left is unreachable by anyone, and the
 * only way back would be writing DynamoDB rows by hand.
 *
 * `isAdminOfOrganization` rather than the ambient `isAdmin`: a person in
 * several workspaces is resolved into exactly one of them for the duration of a
 * request, and that one cannot answer for the workspace named in the URL.
 */

import type { SessionUser } from "@/lib/session";
import { isDeploymentAdmin } from "@/lib/session";
import { isAdminOfOrganization } from "@/lib/workspace";

export async function mayAdministerWorkspace(
  user: SessionUser,
  organizationId: string,
): Promise<boolean> {
  return (
    (await isAdminOfOrganization(user.email, organizationId)) || (await isDeploymentAdmin(user))
  );
}

export const FORBIDDEN_WORKSPACE = () =>
  Response.json({ error: "Only this workspace's admins can change it" }, { status: 403 });
