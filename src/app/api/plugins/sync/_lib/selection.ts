import { z } from "zod";

/**
 * The repository's content applies automatically; deletion is the one act
 * that needs a person. These name what a previous report listed as orphaned —
 * kind-qualified, because the skills and MCP registries may hold one name.
 * One schema for both ways a sync is asked for (GitHub, an uploaded archive),
 * so the delete checkboxes mean the same thing whichever produced the report.
 */
export const selectionSchema = z.object({
  remove: z
    .object({
      skills: z.array(z.string()).max(500).optional(),
      mcpServers: z.array(z.string()).max(500).optional(),
      plugins: z.array(z.string()).max(500).optional(),
    })
    .optional(),
});
