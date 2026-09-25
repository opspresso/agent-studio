/**
 * The slice of the Bot Framework (Microsoft Teams) surface this platform uses;
 * faked in tests. One definition for every Teams-facing module — the reply
 * channel, the activity handler and the settings use cases all take this same
 * port, and the adapter in `infrastructure/teams` implements it. In `domain`
 * so both sides can name it without either importing the other.
 *
 * Every call takes the bot's credentials first: bots are per agent, and
 * which app a call goes out as is the caller's knowledge, never the adapter's.
 */

/** An Azure Bot registration: the Microsoft App ID and its client secret. */
export interface TeamsCredentials {
  appId: string;
  appPassword: string;
  /** A single-tenant registration's tenant; absent for a multi-tenant one. */
  tenantId?: string;
}

/** Public-cloud Bot Framework endpoint for proactive messages. */
export const PUBLIC_TEAMS_SERVICE_URL = "https://smba.trafficmanager.net/teams/";

/** What this platform sends back into a conversation. */
export interface TeamsOutboundActivity {
  type: "message" | "typing";
  /** Markdown, as Teams renders it for bots (`textFormat: "markdown"`). */
  text?: string;
  /** The activity being answered — a reply in a channel thread. */
  replyToId?: string;
  /** Inline pictures, as `data:` URIs Teams renders in the message. */
  attachments?: Array<{ contentType: string; contentUrl: string; name?: string }>;
}

export interface TeamsClientPort {
  /**
   * Whether an inbound request really came from the Bot Framework for this
   * app: its bearer token verifies against the Bot Framework's signing keys,
   * names this app as audience, and was issued for the `serviceUrl` the
   * activity claims. Everything the endpoint trusts rests on this.
   */
  verifyRequest(
    authorization: string | null,
    expected: { appId: string; serviceUrl: string },
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Acquire (or reuse) a token for the app — the one call that proves a credential works. */
  authenticate(credentials: TeamsCredentials): Promise<{ expiresInSeconds: number }>;
  sendActivity(
    credentials: TeamsCredentials,
    serviceUrl: string,
    conversationId: string,
    activity: TeamsOutboundActivity,
  ): Promise<{ id: string }>;
  updateActivity(
    credentials: TeamsCredentials,
    serviceUrl: string,
    conversationId: string,
    activityId: string,
    activity: TeamsOutboundActivity,
  ): Promise<void>;
  /**
   * Fetch a file a person attached, bounded *while it is read*. The bot's
   * token is attached only to an address on the conversation's own service
   * host — an attachment URL is untrusted input from the activity.
   */
  downloadAttachment(
    credentials: TeamsCredentials,
    serviceUrl: string,
    url: string,
    maxBytes: number,
  ): Promise<Buffer>;
}
