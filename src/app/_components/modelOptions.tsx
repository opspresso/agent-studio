"use client";

/**
 * How a model reads in a picker.
 *
 * The same model is now reachable by several routes — its vendor's own API,
 * Bedrock, a router — so three options can carry the identical display name and
 * differ only in who serves them and what they charge. A list of three "Opus
 * 4.8"s is a coin flip; these group the options by provider and put the price
 * on each one, which is the pair of facts the choice actually turns on.
 *
 * Shared rather than written per picker: the version editor alone has three
 * (model, fallback, image model) and the /models console prices the same way.
 */

import { CheckIcon, Group, Text } from "@mantine/core";
import type { ComboboxData, ComboboxItem } from "@mantine/core";
import type { ModelConfig, ModelType } from "@/domain/llm/models";
import { formatUsd } from "@/app/_lib/formatUsd";

type ModelOption = ModelConfig & { favorite?: boolean };

/**
 * What a model costs, in the terms it is actually billed in.
 *
 * An image model's output is image tokens (`imageOutputPer1M`) or a flat price
 * per picture — never `outputPer1M`, which is the text rate and is 0 for a model
 * that emits no text. Reading only the text pair printed `$5.00 in · $0.00 out`
 * for GPT Image 2, which bills $30.00 per 1M image tokens: the one field the
 * money is in was the one field the label skipped.
 *
 * `perImage` leads where it exists, because comparing pictures is what an image
 * model is chosen on — marked `≈` when the model is billed by tokens and that
 * number is the registry's illustration of a typical image rather than a rate
 * (`ModelPricing.perImage` says which is which).
 */
export function modelPriceLabel(
  pricing: ModelConfig["pricing"],
  type: ModelType = "text",
): string {
  const { inputPer1M, outputPer1M, imageOutputPer1M, perImage } = pricing;
  if (type === "embedding") {
    return `${formatUsd(inputPer1M)} in per 1M`;
  }
  if (imageOutputPer1M === undefined && perImage === undefined) {
    // Zero on both sides is a self-hosted model's stated price — the registry
    // refuses it everywhere else — and `$0.00 in · $0.00 out` reads like
    // missing data rather than a free channel.
    if (inputPer1M === 0 && outputPer1M === 0) {
      return "Free";
    }
    return `${formatUsd(inputPer1M)} in · ${formatUsd(outputPer1M)} out per 1M`;
  }
  const image =
    perImage !== undefined
      ? `${imageOutputPer1M ? "≈" : ""}${formatUsd(perImage)} / image`
      : `${formatUsd(imageOutputPer1M ?? 0)} image out per 1M`;
  return inputPer1M > 0 ? `${image} · ${formatUsd(inputPer1M)} in per 1M` : image;
}

/**
 * The option label, which is what the closed input shows. The id is in it
 * because that is where the provider is: a name alone cannot say which of three
 * routes is selected once the picker is shut.
 */
export function modelOptionLabel(model: ModelConfig): string {
  return `${model.displayName} (${model.id})`;
}

/** Selected model in one line, for a Select's description. */
export function modelSummary(model: ModelConfig): string {
  return `${model.provider} · ${modelPriceLabel(model.pricing)}`;
}

/**
 * Makes a searchable Select filter from scratch when focused.
 *
 * The input holds the selected option's label, and typing into it *appends* —
 * so on a picker whose labels carry the id, searching for "solar" produced the
 * query `GPT-5.4 (openai/gpt-5.4)solar` and an empty list. Selecting the text
 * on focus means the first keystroke replaces it, which is what typing into a
 * picker of seventy models is for.
 */
export const selectOnFocus = {
  onFocus: (event: React.FocusEvent<HTMLInputElement>) => event.currentTarget.select(),
};

/**
 * Options grouped by provider, in registry order within each group.
 *
 * `leading` is prepended ungrouped, for the pickers that offer something that
 * is not a selectable model — "Default", or a stored id now hidden or removed.
 */
export function modelSelectData(
  models: ModelOption[],
  leading: ComboboxItem[],
  favoriteGroupLabel: string,
): ComboboxData {
  const groups = new Map<string, ComboboxItem[]>();
  const favorites = models.filter((model) => model.favorite === true);
  for (const model of models.filter((model) => model.favorite !== true)) {
    groups.set(model.provider, [
      ...(groups.get(model.provider) ?? []),
      { value: model.id, label: modelOptionLabel(model) },
    ]);
  }
  return [
    ...leading,
    ...(favorites.length > 0
      ? [
          {
            group: favoriteGroupLabel,
            items: favorites.map((model) => ({ value: model.id, label: modelOptionLabel(model) })),
          },
        ]
      : []),
    ...[...groups].map(([provider, items]) => ({ group: provider, items })),
  ];
}

/**
 * Renders one option: the model over its id, with the price on the right and a
 * tick on the one that is currently selected.
 *
 * The tick has to be drawn here. Mantine renders its own check icon only for
 * the *default* option renderer — supplying `renderOption` replaces that whole
 * row, and the first version of this dropped the mark silently: a list of
 * sixty models with no indication of which one the version already uses.
 * `checked` arrives beside the option for exactly this.
 *
 * The renderer is also handed only `{ value, label }`, so the model is looked
 * up by id — an option that is not a model (the leading entries above) falls
 * back to its plain label rather than rendering an empty price.
 */
export function renderModelOption(models: ModelOption[]) {
  const byId = new Map(models.map((model) => [model.id, model]));
  return function ModelOption({ option, checked }: { option: ComboboxItem; checked?: boolean }) {
    const model = byId.get(option.value);
    const tick = (
      <CheckIcon size={12} style={{ flexShrink: 0, opacity: checked ? 1 : 0 }} aria-hidden />
    );
    if (!model) {
      return (
        <Group gap="xs" wrap="nowrap" style={{ flex: 1 }}>
          {tick}
          <Text fz="sm">{option.label}</Text>
        </Group>
      );
    }
    return (
      <Group gap="xs" wrap="nowrap" style={{ flex: 1 }}>
        {tick}
        <Group justify="space-between" gap="md" wrap="nowrap" style={{ flex: 1 }}>
          <div>
            <Text fz="sm" fw={checked ? 600 : undefined}>
              {model.displayName}
            </Text>
            <Text fz="xs" c="dimmed" ff="monospace">
              {model.id}
            </Text>
          </div>
          <Text fz="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
            {modelPriceLabel(model.pricing)}
          </Text>
        </Group>
      </Group>
    );
  };
}
