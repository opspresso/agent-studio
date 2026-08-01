import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { dynamodbAdapter } from "@/infrastructure/db/authAdapter";
import { config } from "./config";
import { getAllowedEmailDomains } from "./runtime-settings";

async function assertAllowedEmailDomain(email: string): Promise<void> {
  const allowed = await getAllowedEmailDomains();
  if (allowed.length === 0) {
    return;
  }
  const domain = email.split("@").at(-1)?.toLowerCase() ?? "";
  if (!allowed.includes(domain)) {
    throw new APIError("FORBIDDEN", {
      message: `Sign-in is restricted to: ${allowed.join(", ")}`,
    });
  }
}

export const auth = betterAuth({
  database: dynamodbAdapter,
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
      },
    },
  },
  advanced: {
    ipAddress: {
      trustedProxies: config.trustedProxyCidrs,
    },
  },
  plugins: [nextCookies()],
});
