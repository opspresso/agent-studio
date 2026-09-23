/**
 * How long a signed object URL lives, by who is going to fetch it.
 *
 * URL lifetimes depend on where readers receive artifact links. Shared across
 * the browser and server for chat, the gallery, and messaging replies.
 */

/**
 * A chat view. The person already has the page open; a short window is enough,
 * and a page left open overnight re-reads the chat before it can show anything
 * anyway.
 */
export const VIEW_URL_TTL_SECONDS = 15 * 60;

/**
 * A link sent by a messaging bot may be read long after it is sent.
 *
 * Messaging replies may be revisited days later. Seven days is the maximum
 * SigV4 pre-sign lifetime with an IAM user key. The URL grants access to its
 * object for that period to the recipients of the reply; the artifact itself
 * remains in the Agent's gallery according to its retention policy.
 */
export const RECORD_URL_TTL_SECONDS = 7 * 24 * 60 * 60;
