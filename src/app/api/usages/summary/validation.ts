import { z } from "zod";

export const MAX_RANGE_DAYS = 184;
const DAY_MS = 86_400_000;

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be yyyy-MM-dd");

/** Number of days spanned by [from, to], inclusive of both endpoints. */
export function inclusiveDays(from: string, to: string): number {
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  const toMs = Date.parse(`${to}T00:00:00Z`);
  return Math.round((toMs - fromMs) / DAY_MS) + 1;
}

export const summaryQuerySchema = z
  .object({
    from: dateSchema,
    to: dateSchema,
    project: z.string().min(1).optional(),
  })
  .refine((v) => v.from <= v.to, {
    message: "from must be on or before to",
    path: ["from"],
  })
  .refine((v) => inclusiveDays(v.from, v.to) <= MAX_RANGE_DAYS, {
    message: `date range must be ${MAX_RANGE_DAYS} days or less`,
    path: ["to"],
  });

export type SummaryQuery = z.infer<typeof summaryQuerySchema>;
