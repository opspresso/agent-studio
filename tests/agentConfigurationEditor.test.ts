import { describe, expect, it } from "vitest";
import { parseJsonObject, parseConfigurationDraft } from "@/app/projects/[name]/_components/AgentConfigurationEditor";
import type { AgentConfigurationInput } from "@/app/projects/lib/api";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { SubagentInput } from "@/app/projects/[name]/_components/inputs";

describe("subagent picker identity", () => {
  it("renders local and remote candidates with the same name", () => {
    const render = () => renderToStaticMarkup(createElement(MantineProvider, {
      children: createElement(SubagentInput, {
        values: [],
        onChange: () => {},
        options: [
          { value: "helper", type: "local", description: "Local helper" },
          { value: "helper", type: "remote", description: "Remote helper" },
        ],
      }),
    }));
    expect(render).not.toThrow();
  });
});

describe("parseJsonObject", () => {
  it("accepts only JSON objects", () => {
    expect(parseJsonObject('{"type":"object"}')).toEqual({ type: "object" });
    expect(parseJsonObject("{}")).toEqual({});
  });

  it.each(["[]", '"schema"', "42", "null", "{broken"])("rejects %s", (text) => {
    expect(parseJsonObject(text)).toBeNull();
  });
});

describe("parseConfigurationDraft", () => {
  const configuration: AgentConfigurationInput = {
    model: "model",
    systemPrompt: "Answer the question",
    parameters: {
      piiFiltering: false,
      structuredOutput: true,
      jsonSchema: { type: "object", required: ["answer"] },
    },
    mcpList: [],
    skillList: [],
    subagentList: [],
  };

  it("refuses an invalid current draft even when the configuration holds a valid schema", () => {
    expect(parseConfigurationDraft(configuration, '{"type":"object"}')?.parameters.jsonSchema).toEqual({ type: "object" });
    expect(parseConfigurationDraft(configuration, '{"type":')).toBeNull();
    const corrected = parseConfigurationDraft(configuration, '{"type":"object","required":["result"]}');
    expect(corrected).toEqual({
      ...configuration,
      parameters: { ...configuration.parameters, jsonSchema: { type: "object", required: ["result"] } },
    });
    expect(configuration.parameters.jsonSchema).toEqual({ type: "object", required: ["answer"] });
  });

  it("preserves the stored schema while structured output is off and rejects the draft when re-enabled", () => {
    const text = '{"type":';
    const disabled = { ...configuration, parameters: { ...configuration.parameters, structuredOutput: false } };
    expect(parseConfigurationDraft(disabled, text)).toEqual(disabled);
    expect(parseConfigurationDraft(configuration, text)).toBeNull();
  });

  it("allows an explicitly empty draft to remove the schema", () => {
    expect(parseConfigurationDraft(configuration, " \n ")).toEqual({
      ...configuration,
      parameters: { ...configuration.parameters, jsonSchema: undefined },
    });
  });

  it("builds a newly selected configuration from its own schema after an invalid draft", () => {
    expect(parseConfigurationDraft(configuration, "{broken")).toBeNull();
    const next = { ...configuration, parameters: { ...configuration.parameters, jsonSchema: { properties: { next: {} } } } };
    expect(parseConfigurationDraft(next, JSON.stringify(next.parameters.jsonSchema))).toEqual(next);
  });

  it("keeps the saved snapshot aligned with the raw draft when storage reorders schema keys", () => {
    const text = '{"type":"object","required":["answer"]}';
    const saved = {
      ...configuration,
      parameters: { ...configuration.parameters, jsonSchema: { required: ["answer"], type: "object" } },
    };
    const snapshot = JSON.stringify(parseConfigurationDraft(saved, text));
    expect(snapshot).toBe(JSON.stringify(parseConfigurationDraft(configuration, text)));
    expect(JSON.stringify(parseConfigurationDraft(saved, '{"type":"object","required":["result"]}'))).not.toBe(snapshot);
  });
});
