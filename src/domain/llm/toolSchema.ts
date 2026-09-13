/** Compiles deployment-supplied JSON Schema without performing network reads. */
export interface ToolSchemaValidator {
  /** Returns a validator that throws on invalid input and never changes it. */
  compile(schema: Record<string, unknown>): (input: unknown) => void;
}
