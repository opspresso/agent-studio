import { z } from "zod";

/** Validate the fields the Telegram gate and handler read before either runs. */
const user = z.object({
  id: z.number().int().positive(),
  is_bot: z.boolean().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
}).passthrough();

const media = z.object({
  file_id: z.string().min(1),
  file_unique_id: z.string().min(1),
  file_name: z.string().optional(),
  mime_type: z.string().optional(),
  file_size: z.number().int().nonnegative().optional(),
}).passthrough();

const entity = z.object({
  type: z.string(),
  offset: z.number().int().nonnegative(),
  length: z.number().int().nonnegative(),
  user: user.optional(),
}).passthrough();

const message = z.object({
  message_id: z.number().int().positive(),
  date: z.number().int().nonnegative().max(8_640_000_000_000),
  chat: z.object({
    id: z.number().int(),
    type: z.enum(["private", "group", "supergroup", "channel"]),
    title: z.string().optional(),
    is_forum: z.boolean().optional(),
  }).passthrough(),
  from: user.optional(),
  text: z.string().optional(),
  caption: z.string().optional(),
  entities: z.array(entity).optional(),
  caption_entities: z.array(entity).optional(),
  reply_to_message: z.object({ from: user.optional() }).passthrough().optional(),
  message_thread_id: z.number().int().positive().optional(),
  is_topic_message: z.boolean().optional(),
  media_group_id: z.string().optional(),
  photo: z.array(media.extend({
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative(),
  })).optional(),
  document: media.optional(),
  voice: media.optional(),
  audio: media.optional(),
  video: media.optional(),
  animation: media.optional(),
  video_note: media.optional(),
  sticker: media.extend({
    is_animated: z.boolean().optional(),
    is_video: z.boolean().optional(),
    emoji: z.string().optional(),
  }).optional(),
}).passthrough();

export const telegramUpdateSchema = z.object({
  update_id: z.number().int().nonnegative(),
  message: message.optional(),
  edited_message: z.unknown().optional(),
  channel_post: z.unknown().optional(),
}).passthrough();
