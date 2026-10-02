import { z } from "zod";
import { withAuth, withMemberAuth } from "@/lib/session";
import { messagingIdentityUseCases } from "@/lib/container";
import { editorBody } from "@/app/api/_lib/body";
import { apiError } from "@/app/api/_lib/http";
import { MESSAGING_PLATFORMS } from "@/domain/messaging/identity";
import type { MessagingIdentity } from "@/domain/messaging/identity";
const issue = z.object({ agentName: z.string().min(1).max(256), platform: z.enum(MESSAGING_PLATFORMS) });
const subject = issue.extend({ realm: z.string().min(1).max(256), externalId: z.string().min(1).max(256) });
export interface MessagingIdentitiesResponse { identities: MessagingIdentity[] }
export type MessagingLinkCodeResponse = Awaited<ReturnType<typeof messagingIdentityUseCases.issue>>;
export const GET = withAuth(async user => {
  try { return Response.json({ identities: await messagingIdentityUseCases.list(user.id) } satisfies MessagingIdentitiesResponse); }
  catch (error) { return apiError(error); }
});
export const POST = withMemberAuth(async (user, request: Request) => {
  const body = await editorBody(request); if (body instanceof Response) return body;
  const parsed = issue.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid messaging link request" }, { status: 400 });
  try { return Response.json(await messagingIdentityUseCases.issue(parsed.data.agentName, parsed.data.platform, user.id)); }
  catch (error) { return apiError(error); }
});
export const DELETE = withAuth(async (user, request: Request) => {
  const body = await editorBody(request); if (body instanceof Response) return body;
  const parsed = subject.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid messaging identity" }, { status: 400 });
  try { await messagingIdentityUseCases.unlink(parsed.data, user.id); return new Response(null, { status: 204 }); }
  catch (error) { return apiError(error); }
});
