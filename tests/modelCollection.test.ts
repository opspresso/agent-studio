import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it } from "vitest";
import { ModelCollection } from "@/app/models/ModelCollection";
import { registrationFromDiscovery } from "@/domain/llm/providerModels";

describe("model collection identities", () => {
  const model = { wireId: "nvidia/Qwen3.6-35B-A3B-NVFP4", displayName: "Qwen3.6-35B-A3B-NVFP4", type: "text" as const };

  it.each(["discovery", "registered"] as const)("shows provider/model for self-hosted %s rows", scope => {
    const rows = scope === "discovery" ? [model] : [registrationFromDiscovery("selfhosted", model)];
    const markup = renderToStaticMarkup(createElement(MantineProvider, {
      children: createElement(ModelCollection, { models: rows, provider: "selfhosted", scope, emptyText: "Empty" }),
    }));
    expect(markup).toContain(">Qwen3.6-35B-A3B-NVFP4<");
    expect(markup).toContain(">selfhosted/Qwen3.6-35B-A3B-NVFP4<");
    expect(markup).not.toContain(">nvidia/Qwen3.6-35B-A3B-NVFP4<");
    expect(markup).not.toContain("selfhosted/nvidia/");
  });

  it("keeps a published ID distinct from the wire ID and connection name", () => {
    const markup = renderToStaticMarkup(createElement(MantineProvider, {
      children: createElement(ModelCollection, {
        models: [{ id: "openrouter/all-minilm-l12-v2", wireId: "sentence-transformers/all-minilm-l12-v2", displayName: "all-MiniLM-L12-v2" }],
        provider: "company-router", scope: "discovery", emptyText: "Empty",
      }),
    }));
    expect(markup).toContain(">all-MiniLM-L12-v2<");
    expect(markup).toContain(">openrouter/all-minilm-l12-v2<");
    expect(markup).not.toContain("company-router/sentence-transformers/");
  });
});
