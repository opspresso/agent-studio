import { z } from "zod";

/** Bot Framework fields read during authentication, engagement and handling. */
const account = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  aadObjectId: z.string().optional(),
}).passthrough();

const conversation = z.object({
  id: z.string().optional(),
  conversationType: z.string().optional(),
  tenantId: z.string().optional(),
  isGroup: z.boolean().optional(),
  name: z.string().optional(),
}).passthrough();

export const teamsActivitySchema = z.object({
  type: z.string().min(1),
  id: z.string().nullish(),
  timestamp: z.string().nullish(),
  serviceUrl: z.string().nullish(),
  channelId: z.string().nullish(),
  from: account.nullish(),
  recipient: account.nullish(),
  conversation: conversation.nullish(),
  text: z.string().nullish(),
  textFormat: z.string().nullish(),
  replyToId: z.string().nullish(),
  entities: z.array(z.object({
    type: z.string(),
    mentioned: account.nullish(),
    text: z.string().nullish(),
  }).passthrough()).nullish(),
  attachments: z.array(z.object({
    contentType: z.string(),
    contentUrl: z.string().nullish(),
    name: z.string().nullish(),
    content: z.unknown().optional(),
  }).passthrough()).nullish(),
}).passthrough();
