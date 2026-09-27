import { z } from "zod";

/** Validate own header entries without dropping names such as __proto__. */
export function headerRecordSchema(value: z.ZodString, name?: z.ZodString): z.ZodType<Record<string, string>>;
export function headerRecordSchema(value: z.ZodNullable<z.ZodString>, name?: z.ZodString): z.ZodType<Record<string, string | null>>;
export function headerRecordSchema(value: z.ZodString | z.ZodNullable<z.ZodString>, name = z.string()): z.ZodType {
  return z.custom<Record<string, unknown>>(
    input => input !== null && typeof input === "object" && !Array.isArray(input),
    "Headers must be an object",
  ).transform(input => Object.entries(input))
    .pipe(z.array(z.tuple([name, value])))
    .transform(entries => Object.fromEntries(entries) as Record<string, string | null>);
}
