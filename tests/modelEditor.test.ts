import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it, vi } from "vitest";
import { ModelEditor } from "@/app/models/ModelEditor";
import { createModelRegistryUseCases } from "@/application/llm/modelRegistry";
import { registrationFromDiscovery } from "@/domain/llm/providerModels";

describe("model price editing", () => {
  it("lets administrators edit cached and image billing rates", () => {
    const model = registrationFromDiscovery("office", {
      wireId: "vendor/image", displayName: "Image", type: "image",
      pricing: { inputPer1M: 4, outputPer1M: 12, cachedInputPer1M: 0.5, imageInputPer1M: 0.7, imageOutputPer1M: 0.9, perInputImage: 0.02 },
    });
    const markup = renderToStaticMarkup(createElement(MantineProvider, { env: "test",
      children: createElement(ModelEditor, { model, onSaved: () => {}, onCancel: () => {} }),
    }));
    const rates = (markup.match(/<input\b[^>]*>/g) ?? []).filter(input => /\bvalue="(?:0\.5|0\.7|0\.9|0\.02)"/.test(input));
    expect(rates).toHaveLength(4);
    for (const input of rates) expect(/\bdisabled(?:=|\s|>)/.test(input)).toBe(false);
  });
  it.each(["selfhosted", "openai"] as const)("shows saved %s prices with the correct edit access", async kind => {
    const pricing = { inputPer1M: 4, outputPer1M: 12 };
    const model = registrationFromDiscovery("office", { wireId: "vendor/model", displayName: "Model", type: "text", pricing });
    const useCases = createModelRegistryUseCases({
      repository: { get: async () => ({ updatedAt: "", registeredModels: [model] }), update: vi.fn() },
      providers: async () => [{ name: "office", kind, baseUrl: "http://inside.test/v1", apiKey: "", auth: "bearer", keepModelPrefix: false }],
      discovery: { list: async () => [] }, changed: async () => {},
      catalogModelId: () => model.id, catalogPricing: () => pricing,
    });
    const [view] = await useCases.list();
    const markup = renderToStaticMarkup(createElement(MantineProvider, { env: "test",
      children: createElement(ModelEditor, { model: view!, onSaved: () => {}, onCancel: () => {} }),
    }));
    const priceInputs = (markup.match(/<input\b[^>]*>/g) ?? []).filter(input => /\bvalue="(?:4|12)"/.test(input));
    expect(priceInputs).toHaveLength(2);
    for (const input of priceInputs) expect(/\bdisabled(?:=|\s|>)/.test(input)).toBe(kind !== "selfhosted");
  });
});
