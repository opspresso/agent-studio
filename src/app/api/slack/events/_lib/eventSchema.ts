import { z } from "zod";

/** Fields the Slack engagement gate and handler read from a signed delivery. */
const prose = z.object({
  text: z.string().nullish(),
  attachments: z.array(z.object({
    pretext: z.string().nullish(),
    title: z.string().nullish(),
    text: z.string().nullish(),
    fallback: z.string().nullish(),
    fields: z.array(z.object({
      title: z.string().nullish(),
      value: z.string().nullish(),
    }).passthrough()).nullish(),
  }).passthrough()).nullish(),
  blocks: z.array(z.object({
    type: z.string().nullish(),
    text: z.object({ text: z.string().nullish() }).passthrough().nullish(),
    fields: z.array(z.object({ text: z.string().nullish() }).passthrough()).nullish(),
    elements: z.array(z.object({
      type: z.string().nullish(),
      text: z.string().nullish(),
    }).passthrough()).nullish(),
  }).passthrough()).nullish(),
});

const event = prose.extend({
  type: z.string().nullish(),
  subtype: z.string().nullish(),
  bot_id: z.string().nullish(),
  user: z.string().nullish(),
  username: z.string().nullish(),
  bot_profile: z.object({ name: z.string().nullish() }).passthrough().nullish(),
  channel: z.string().nullish(),
  channel_type: z.string().nullish(),
  ts: z.string().nullish(),
  event_ts: z.string().nullish(),
  thread_ts: z.string().nullish(),
  tab: z.string().nullish(),
  assistant_thread: z.object({
    channel_id: z.string().nullish(),
    thread_ts: z.string().nullish(),
    user_id: z.string().nullish(),
  }).passthrough().nullish(),
  files: z.array(z.object({
    id: z.string().nullish(),
    name: z.string().nullish(),
    mimetype: z.string().nullish(),
    size: z.number().nonnegative().nullish(),
    url_private_download: z.string().nullish(),
    url_private: z.string().nullish(),
  }).passthrough()).nullish(),
}).passthrough();

export const slackEventSchema = z.object({
  type: z.string().min(1),
  event_id: z.string().nullish(),
  team_id: z.string().nullish(),
  challenge: z.string().nullish(),
  authorizations: z.array(z.object({
    user_id: z.string().nullish(),
    is_bot: z.boolean().nullish(),
  }).passthrough()).nullish(),
  event: event.nullish(),
}).passthrough().refine(
  (payload) => payload.type !== "event_callback" || Boolean(payload.event_id && payload.event?.type),
  "Event callbacks require an event id and type",
);
