import { z } from "zod";
import { isCallRoutingPolicy, type CallRoutingPolicy } from "@/domain/llm/callRouting";

export const modelRoutingPolicySchema = z.object({ policy: z.custom<CallRoutingPolicy>(isCallRoutingPolicy, "Invalid model routing policy") }).strict();
