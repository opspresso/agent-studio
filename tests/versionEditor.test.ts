import { describe, expect, it } from "vitest";
import { parseJsonObject, parseVersionDraft } from "@/app/projects/[name]/_components/VersionEditor";
import type { VersionInput } from "@/app/projects/lib/api";
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

describe("parseVersionDraft", () => {
  const version: VersionInput = {
    model: "model",
    systemPrompt: "Answer the question",
    userPromptTemplate: "{{input}}",
    parameters: {
      piiFiltering: false,
      structuredOutput: true,
      jsonSchema: { type: "object", required: ["answer"] },
    },
    mcpList: [],
    skillList: [],
    subagentList: [],
  };

  it("refuses an invalid current draft even when the version holds a valid schema", () => {
    expect(parseVersionDraft(version, '{"type":"object"}')?.parameters.jsonSchema).toEqual({ type: "object" });
    expect(parseVersionDraft(version, '{"type":')).toBeNull();
    const corrected = parseVersionDraft(version, '{"type":"object","required":["result"]}');
    expect(corrected).toEqual({
      ...version,
      parameters: { ...version.parameters, jsonSchema: { type: "object", required: ["result"] } },
    });
    expect(version.parameters.jsonSchema).toEqual({ type: "object", required: ["answer"] });
  });

  it("preserves the stored schema while structured output is off and rejects the draft when re-enabled", () => {
    const text = '{"type":';
    const disabled = { ...version, parameters: { ...version.parameters, structuredOutput: false } };
    expect(parseVersionDraft(disabled, text)).toEqual(disabled);
    expect(parseVersionDraft(version, text)).toBeNull();
  });

  it("allows an explicitly empty draft to remove the schema", () => {
    expect(parseVersionDraft(version, " \n ")).toEqual({
      ...version,
      parameters: { ...version.parameters, jsonSchema: undefined },
    });
  });

  it("builds a newly selected version from its own schema after an invalid draft", () => {
    expect(parseVersionDraft(version, "{broken")).toBeNull();
    const next = { ...version, parameters: { ...version.parameters, jsonSchema: { properties: { next: {} } } } };
    expect(parseVersionDraft(next, JSON.stringify(next.parameters.jsonSchema))).toEqual(next);
  });

  it("keeps the saved snapshot aligned with the raw draft when storage reorders schema keys", () => {
    const text = '{"type":"object","required":["answer"]}';
    const saved = {
      ...version,
      parameters: { ...version.parameters, jsonSchema: { required: ["answer"], type: "object" } },
    };
    const snapshot = JSON.stringify(parseVersionDraft(saved, text));
    expect(snapshot).toBe(JSON.stringify(parseVersionDraft(version, text)));
    expect(JSON.stringify(parseVersionDraft(saved, '{"type":"object","required":["result"]}'))).not.toBe(snapshot);
  });
});
