import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import type { ToolSchemaValidator } from "@/domain/llm/toolSchema";

/** Separate schema namespaces prevent unrelated tools from reusing one another's $id. */
export function createToolSchemaValidator(): ToolSchemaValidator {
  return {
    compile(schema) {
      if (schema.$async) throw new Error("Asynchronous tool schemas are not supported");
      const validate = new AjvJsonSchemaValidator().getValidator(schema);
      return (input) => {
        const result = validate(input);
        if (!result.valid) throw new Error(`Tool arguments do not match the declared schema: ${result.errorMessage}`);
      };
    },
  };
}
