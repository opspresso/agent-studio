import { describe, expect, it } from "vitest";
import { findTemplateVariables, renderTemplate } from "@/shared/template";

describe("renderTemplate", () => {
  it("substitutes provided variables", () => {
    expect(renderTemplate("A {{color}} cat plays {{instrument}}", { color: "orange", instrument: "piano" })).toBe(
      "A orange cat plays piano",
    );
  });

  it("replaces missing variables with an empty string", () => {
    expect(renderTemplate("Hello {{name}}, {{missing}}!", { name: "World" })).toBe("Hello World, !");
  });

  it("returns an empty string for an empty template", () => {
    expect(renderTemplate("", { name: "x" })).toBe("");
  });

  it("finds variable names", () => {
    expect(findTemplateVariables("{{a}} and {{b}} and {{a}}")).toEqual(new Set(["a", "b"]));
  });
});
