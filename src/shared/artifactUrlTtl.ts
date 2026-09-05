/**
 * How long a signed object URL lives, by who is going to fetch it.
 *
 * Two lifetimes for two kinds of reader, and the difference is load-bearing
 * rather than cosmetic. Shared across the browser and server because the
 * readers span the whole app — the chat view, the artifacts gallery, a Slack
 * thread, a stored A2A task — and all of them are looking at the same objects.
 */

/**
 * A chat view. The person already has the page open; a short window is enough,
 * and a page left open overnight re-reads the chat before it can show anything
 * anyway.
 */
export const VIEW_URL_TTL_SECONDS = 15 * 60;

/**
 * A link that goes into something durable and is read long afterwards: a Slack
 * thread, a stored A2A task.
 *
 * The view assumes a reader who is present, while a Slack message breaks that
 * assumption completely. It is a record: the answer is read minutes later by
 * the person who asked and days later by whoever searches the channel. Signed at
 * {@link VIEW_URL_TTL_SECONDS} the link was dead before most readers reached it,
 * and an expired signature is an S3 `AccessDenied` document with nothing in it
 * that says what went wrong.
 *
 * Seven days because that is the ceiling a SigV4 presigned URL can carry, so
 * this is the signer's own limit rather than a number picked here — past it
 * there is nothing longer to choose. The trade is stated rather than hidden:
 * the URL is a bearer capability for that object for a week, held by exactly
 * the audience that could already read the answer it came with (a channel's
 * members, a holder of the project's A2A key). The artifact itself outlives the
 * link either way, in the project's gallery.
 */
export const RECORD_URL_TTL_SECONDS = 7 * 24 * 60 * 60;
