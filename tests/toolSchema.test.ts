import { afterEach, describe, expect, it, vi } from "vitest";
import { createToolSchemaValidator } from "@/infrastructure/llm/toolSchema";

afterEach(() => vi.unstubAllGlobals());

describe("tool JSON Schema validation", () => {
  it("validates nested unions, local references and array bounds without changing the input", () => {
    const validate = createToolSchemaValidator().compile({
      type: "object", additionalProperties: false, required: ["values"],
      properties: { values: { type: "array", minItems: 1, maxItems: 2, items: { $ref: "#/$defs/value" } } },
      $defs: { value: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] } },
    });
    const valid = { values: [1, null] };
    validate(valid);
    expect(valid).toEqual({ values: [1, null] });
    for (const invalid of [{}, { values: [] }, { values: [0] }, { values: ["1"] }, { values: [1, 2, 3] }, { values: [1], extra: true }]) {
      expect(() => validate(invalid)).toThrow("declared schema");
    }
  });

  it("isolates two different tools that declare the same schema ID", () => {
    const compiler = createToolSchemaValidator();
    const numeric = compiler.compile({ $id: "urn:studio:tool", type: "object", properties: { value: { type: "number" } } });
    const text = compiler.compile({ $id: "urn:studio:tool", type: "object", properties: { value: { type: "string" } } });
    expect(() => numeric({ value: "1" })).toThrow();
    expect(() => text({ value: 1 })).toThrow();
    expect(() => text({ value: "1" })).not.toThrow();
  });

  it.each(["http://json-schema.org/draft-07/schema#", "https://json-schema.org/draft/2020-12/schema"])("supports declared dialect %s", ($schema) => {
    const validate = createToolSchemaValidator().compile({ $schema, type: "object", properties: { email: { type: "string", format: "email" } } });
    expect(() => validate({ email: "valid@example.com" })).not.toThrow();
    expect(() => validate({ email: "invalid" })).toThrow();
  });

  it("refuses remote references and asynchronous schemas without network access", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const compiler = createToolSchemaValidator();
    expect(() => compiler.compile({ type: "object", $ref: "https://schema.test/private.json" })).toThrow();
    expect(() => compiler.compile({ type: "object", $async: true })).toThrow("Asynchronous");
    expect(fetch).not.toHaveBeenCalled();
  });
});
