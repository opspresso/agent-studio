import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { genericOAuth } from "better-auth/plugins";
import { DEFAULT_MEMBER_TIER } from "@/domain/member/tiers";
import { getPool } from "@/infrastructure/db/client";
import { log } from "@/shared/logger";
import { EMAIL_DOMAIN_NOT_ALLOWED, OIDC_PROVIDER_ID } from "@/shared/signInError";
import { config } from "./config";
import { AUTH_COOKIE_PREFIX } from "@/shared/authCookies";
import { getAllowedEmailDomains, isConfiguredAdmin } from "./runtime-settings";

/**
 * The bootstrap administrator is the one address the operator named outright,
 * and the account for when everything else locks people out — a provider
 * down, an allowed-domain list narrowed too far. So the list does not apply
 * to it: otherwise a first boot with `BOOTSTRAP_ADMIN_EMAIL` outside
 * `ALLOWED_EMAIL_DOMAINS` fails in the create-user hook and the break-glass
 * account can never sign in.
 */
export function isBootstrapAdminEmail(email: string): boolean {
  const bootstrap = config.passwordAuth ? config.bootstrapAdmin : undefined;
  return bootstrap !== undefined && email.toLowerCase() === bootstrap.email.toLowerCase();
}

async function assertAllowedEmailDomain(email: string): Promise<void> {
  if (isBootstrapAdminEmail(email)) {
    return;
  }
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

const google = config.googleOAuth;
const oidc = config.oidc;

export const auth = betterAuth({
  // The library's own Postgres adapter over this app's pool: the auth tables
  // are the one part of the schema it owns, and `memberRepository` reads
  // them as tables rather than through the adapter.
  database: getPool(),
  user: {
    additionalFields: {
      lastLoginAt: { type: "date", required: false, input: false },
      // `input: false` is the security property: no Better Auth API surface
      // lets a user set their own tier. Admin changes go through
      // `memberRepository.setTier`, never the adapter's whole-item update.
      tier: { type: "string", required: false, input: false, defaultValue: DEFAULT_MEMBER_TIER },
    },
  },
  // Sign-up is by signing in: a person the identity provider vouches for
  // becomes a user on first arrival (the domain hook above still applies).
  // Password accounts are the exception — nobody vouches for those, so the
  // form creates none; the bootstrap administrator is made at boot, and any
  // other password account is an administrator's deliberate act.
  emailAndPassword: {
    enabled: config.passwordAuth,
    disableSignUp: true,
  },
  ...(google ? { socialProviders: { google } } : {}),
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
              const user = await ctx.context.internalAdapter.findUserById(session.userId);
              await ctx.context.internalAdapter.updateUser(session.userId, {
                lastLoginAt: new Date(),
                ...(user && await isConfiguredAdmin(user.email) ? { tier: "admin" } : {}),
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
     * used the wrong account with nothing to click; `/login` reads the
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
    cookiePrefix: AUTH_COOKIE_PREFIX,
    ipAddress: {
      trustedProxies: config.trustedProxyCidrs,
    },
  },
  plugins: [
    nextCookies(),
    // A standard OIDC provider, found through its discovery document. One per
    // installation: an enterprise has one directory, and a second provider is
    // a second source of truth for who a person is.
    ...(oidc
      ? [
          genericOAuth({
            config: [
              {
                providerId: OIDC_PROVIDER_ID,
                discoveryUrl: `${oidc.issuer}/.well-known/openid-configuration`,
                clientId: oidc.clientId,
                clientSecret: oidc.clientSecret,
                scopes: oidc.scopes,
                pkce: true,
              },
            ],
          }),
        ]
      : []),
  ],
});

/**
 * Create the bootstrap administrator when password sign-in is on and nobody
 * by that email exists yet. Called once at boot, after the schema is in
 * place; a second boot finds the user and does nothing, and a later change
 * to the variable changes nothing either — the account is the person's to
 * manage from then on.
 */
export async function ensureBootstrapAdmin(): Promise<void> {
  const bootstrap = config.bootstrapAdmin;
  if (!bootstrap) {
    return;
  }
  if (!config.passwordAuth) {
    log.warn("authz", "BOOTSTRAP_ADMIN_EMAIL is set but AUTH_PASSWORD is not true; no account created");
    return;
  }
  const ctx = await auth.$context;
  const existing = await ctx.internalAdapter.findUserByEmail(bootstrap.email);
  // A user who already has a password account is done — theirs to manage. A
  // user without one is a bootstrap that stopped between the two writes (or
  // an account that arrived some other way and now needs a password to
  // break glass with): the credential is added, the user row left alone.
  if (existing && (await ctx.internalAdapter.findCredentialAccount(existing.user.id))) {
    return;
  }
  // `email` is unique, and every instance runs this at boot: two starting
  // together can both read "nobody" and attempt creation. The loser reads the
  // winning row back instead — the account exists either way.
  const user =
    existing?.user ??
    (await ctx.internalAdapter
      .createUser(
        { email: bootstrap.email, name: "Administrator", emailVerified: true },
        { method: "email-password" },
      )
      .catch(async (error: unknown) => {
        const raced = await ctx.internalAdapter.findUserByEmail(bootstrap.email);
        if (!raced) {
          throw error;
        }
        log.info("authz", `bootstrap administrator ${bootstrap.email} was created by another instance`);
        return raced.user;
      }));
  // Password accounts use the library's providerId + accountId identity.
  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: "credential",
    accountId: user.id,
    password: await ctx.password.hash(bootstrap.password),
  }).catch(async (error: unknown) => {
    // Another boot can link the same credential after our initial read.
    // Accept only a confirmed account for this user; other failures remain fatal.
    if (!(await ctx.internalAdapter.findCredentialAccount(user.id))) throw error;
  });
  log.info("authz", `${existing ? "added a password to" : "created"} bootstrap administrator ${bootstrap.email}`);
}
