import { z } from "zod";
import type {
  CreateManagedInput,
  UpdateManagedInput,
} from "@/application/mcp/managedMcpUseCases";
import {
  MANAGED_ARG,
  MANAGED_ENDPOINT_PATH,
  MANAGED_ENV_KEY,
  MANAGED_ENV_REF,
  MANAGED_ENV_VALUE,
  MANAGED_IMAGE,
} from "@/domain/mcp/provisioner";
import { MANAGED_NAME } from "@/domain/naming";

const workloadSchema = z.object({
  image: z.string().trim().regex(MANAGED_IMAGE),
  containerPort: z.number().int().min(1).max(65535),
  envRefs: z.array(z.string().trim().regex(MANAGED_ENV_REF)).optional(),
  environment: z
    .record(
      z.string().regex(MANAGED_ENV_KEY),
      z.string().max(16_384).regex(MANAGED_ENV_VALUE, "line breaks are not allowed"),
    )
    .refine((values) => values.PORT === undefined, "PORT is managed by the runtime")
    .optional(),
  args: z.array(z.string().min(1).max(1024).regex(MANAGED_ARG)).max(64).optional(),
  endpointPath: z.string().trim().regex(MANAGED_ENDPOINT_PATH).optional(),
  description: z.string().optional(),
  content: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const createManagedMcpSchema: z.ZodType<CreateManagedInput> = workloadSchema.extend({
  name: z.string().regex(MANAGED_NAME),
});

export const updateManagedMcpSchema: z.ZodType<UpdateManagedInput> = workloadSchema.partial();
