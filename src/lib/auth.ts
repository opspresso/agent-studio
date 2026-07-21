import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { dynamodbAdapter } from "./auth-adapter";

export const auth = betterAuth({
  database: dynamodbAdapter,
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    },
  },
  plugins: [nextCookies()],
});
