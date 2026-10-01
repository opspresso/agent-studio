import { ForbiddenError, ConflictError, ValidationError } from "@/application/errors";
import type { MessagingSubject } from "@/domain/messaging/identity";
import type { MessagingIdentityUseCases } from "@/application/auth/messagingIdentityUseCases";
import type { ReplyChannel } from "@/domain/messaging/reply";

const AUTH_COMMAND = /^\s*\/?auth(?:@\w+)?(?:\s|$)/i;

/** Also exclude incomplete commands when replaying platform-provided history. */
export function isMessagingAuthenticationCommand(text: string): boolean {
  return AUTH_COMMAND.test(text);
}

/** Authentication commands never enter Agent history, model input or document processing. */
export async function authenticateMessagingSubject(
  identities: Pick<MessagingIdentityUseCases, "connect" | "resolve">,
  subject: MessagingSubject,
  text: string,
  privateChat: boolean,
  reply: Pick<ReplyChannel, "say">,
) {
  try {
    if (isMessagingAuthenticationCommand(text)) {
      if (!privateChat) {
        await reply.say("Authenticate in a private chat with this Agent. Issue a new code in Studio Profile → Messaging connections.");
        return null;
      }
      const code = text.replace(AUTH_COMMAND, "").trim();
      await identities.connect(subject, code);
      await reply.say("Messaging account authenticated. Future Agent requests will use your Studio account and current permissions.");
      return null;
    }
    const user = await identities.resolve(subject);
    if (!user) {
      await reply.say("Sign in to Studio, open Profile → Messaging connections, issue a code for this Agent and send auth <code> here in a private chat.");
    }
    return user;
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof ConflictError || error instanceof ValidationError) {
      await reply.say(error.message);
      return null;
    }
    throw error;
  }
}
