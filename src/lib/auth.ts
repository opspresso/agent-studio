import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { dynamodbAdapter } from "@/infrastructure/db/authAdapter";
import { log } from "@/shared/logger";
import { EMAIL_DOMAIN_NOT_ALLOWED } from "@/shared/signInError";
import { config } from "./config";
import { getAllowedEmailDomains } from "./runtime-settings";

async function assertAllowedEmailDomain(email: string): Promise<void> {
  const allowed = await getAllowedEmailDomains();
  if (allowed.length === 0) {
    return;
  }
  const domain = email.split("@").at(-1)?.toLowerCase() ?? "";
  if (!allowed.includes(domain)) {
    // The message leaves for the browser as a query parameter, so it names only
    // which refusal this was. What a refusal is worth knowing — who was turned
    // away, and against what — stays on this side.
    log.warn("authz", `sign-in refused for ${email}: not one of ${allowed.join(", ")}`);
    // `code` and `message` carry the same thing because this function's two
    // callers leave by different doors. Refusing a *new* user throws inside Better
    // Auth's create-user try, which forwards the message; refusing an existing
    // one throws at session creation, which sits outside it and reaches the
    // callback's own handler — and that one redirects only when the error has a
    // `code`, otherwise rethrowing it as a bare 403 JSON body. Filling both is
    // what makes either refusal land on `/login` looking the same.
    throw new APIError("FORBIDDEN", {
      message: EMAIL_DOMAIN_NOT_ALLOWED,
      code: EMAIL_DOMAIN_NOT_ALLOWED,
    });
  }
}

export const auth = betterAuth({
  database: dynamodbAdapter,
  user: {
    additionalFields: {
      lastLoginAt: { type: "date", required: false, input: false },
    },
  },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          await assertAllowedEmailDomain(user.email);
          return { data: user };
        },
      },
    },
    session: {
      create: {
        before: async (session, ctx) => {
          const user = await ctx?.context.internalAdapter.findUserById(session.userId);
          if (user) {
            await assertAllowedEmailDomain(user.email);
          }
          return { data: session };
        },
        after: async (session, ctx) => {
          if (ctx) {
            try {
              await ctx.context.internalAdapter.updateUser(session.userId, {
                lastLoginAt: new Date(),
              });
            } catch (error) {
              log.error("authz", `failed to record login for user ${session.userId}`, error);
            }
          }
        },
      },
    },
  },
  onAPIError: {
    /**
     * Where a refused sign-in lands. Better Auth's own error page is outside
     * this app's UI and offers no way to try again, which leaves someone who
     * used the wrong Google account with nothing to click; `/login` reads the
     * `error` parameter back through `signInErrorMessage` and still has the
     * sign-in button on it.
     *
     * Absolute once the deployment knows its public address — behind a proxy
     * the request URL reflects the bind address, which is why `publicBaseUrl`
     * exists at all.
     */
    errorURL: `${config.publicBaseUrl ?? ""}/login`,
  },
  advanced: {
    ipAddress: {
      trustedProxies: config.trustedProxyCidrs,
    },
  },
  plugins: [nextCookies()],
});
