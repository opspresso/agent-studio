import { z } from "zod";
import { daySpan, isUtcDay } from "@/shared/date";

export const MAX_RANGE_DAYS = 184;

// `isUtcDay`, not a shape regex: `2026-02-31` used to pass here and reach
// `inclusiveDays` as March 3rd, answering `{items: []}` for a range the
// caller never asked about.
const dateSchema = z.string().refine(isUtcDay, "must be yyyy-MM-dd, naming a real UTC day");

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
  .refine((v) => daySpan(v.from, v.to) <= MAX_RANGE_DAYS, {
    message: `date range must be ${MAX_RANGE_DAYS} days or less`,
    path: ["to"],
  });

export type SummaryQuery = z.infer<typeof summaryQuerySchema>;
