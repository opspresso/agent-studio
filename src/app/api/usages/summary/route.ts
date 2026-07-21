import { z } from "zod";
import { withAuth } from "@/lib/session";
import { usageRepository } from "@/infrastructure/db/repositories/usageRepository";

const MAX_RANGE_DAYS = 184;
const DAY_MS = 86_400_000;

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be yyyy-MM-dd");

function inclusiveDays(from: string, to: string): number {
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  const toMs = Date.parse(`${to}T00:00:00Z`);
  return Math.round((toMs - fromMs) / DAY_MS) + 1;
}

const querySchema = z
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

export const GET = withAuth(async (_user, request: Request) => {
  const params = new URL(request.url).searchParams;
  const parsed = querySchema.safeParse({
    from: params.get("from"),
    to: params.get("to"),
    project: params.get("project") ?? undefined,
  });

  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? "invalid query" },
      { status: 400 },
    );
  }

  const { from, to, project } = parsed.data;
  const items = project
    ? await usageRepository.listByProject(project, from, to)
    : await usageRepository.listByDateRange(from, to);

  return Response.json({ items });
});
