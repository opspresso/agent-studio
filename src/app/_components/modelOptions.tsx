"use client";

/**
 * Shared model picker presentation: provider groups, registered ids and prices
 * distinguish connections that use the same display name. Favorites form their
 * own group while ordinary entries retain registry order within each provider.
 */

import { CheckIcon, Group, Select, Text } from "@mantine/core";
import { useMemo } from "react";
import type { ComboboxData, ComboboxItem, SelectProps } from "@mantine/core";
import { modelType, type ModelConfig, type ModelType } from "@/domain/llm/models";
import { formatUsd } from "@/app/_lib/formatUsd";
import { useT } from "@/app/_i18n/provider";

export type ModelOption = ModelConfig & { favorite?: boolean };

/** Unit rates retain significant decimals, to a maximum of ten fractional digits. */
export function formatModelPrice(value: number): string {
  const precision = value.toFixed(10).replace(/0+$/, "").split(".")[1]?.length ?? 0;
  return formatUsd(value, Math.max(value !== 0 && Math.abs(value) < 0.01 ? 4 : 2, precision));
}

/**
 * What a model costs, in the terms it is actually billed in.
 *
 * Display image output, input-image fees, audio minutes and rerank requests
 * using their pricing fields. Missing pricing is distinct from explicit zeros.
 *
 * `perImage` leads where it exists, because comparing pictures is what an image
 * model is chosen on — marked `≈` when the model is billed by tokens and that
 * number is the registry's illustration of a typical image rather than a rate
 * (`ModelPricing.perImage` says which is which).
 */
export function modelPriceLabel(
  pricing: ModelConfig["pricing"] | undefined,
  type: ModelType = "text",
): string {
  if (!pricing) return "Price not provided";
  const {
    inputPer1M,
    outputPer1M,
    imageInputPer1M,
    imageOutputPer1M,
    perImage,
    perInputImage,
    perSearch,
    perAudioMinute,
  } = pricing;
  if (type === "embedding") {
    return `${formatModelPrice(inputPer1M)} in per 1M`;
  }
  if (type === "rerank" && perSearch !== undefined) return `${formatModelPrice(perSearch)} / search`;
  if (type === "rerank") return `${formatModelPrice(inputPer1M)} in per 1M`;
  if (type === "transcription" && perAudioMinute !== undefined) {
    return `${formatModelPrice(perAudioMinute)} / audio minute`;
  }
  const imageInput = [
    imageInputPer1M !== undefined && imageInputPer1M > 0
      ? `${formatModelPrice(imageInputPer1M)} image in per 1M` : undefined,
    perInputImage !== undefined && perInputImage > 0
      ? `${formatModelPrice(perInputImage)} / input image` : undefined,
  ].filter((value): value is string => value !== undefined);
  if (imageOutputPer1M === undefined && perImage === undefined) {
    // Explicit zero prices are free; missing pricing was handled above.
    if (inputPer1M === 0 && outputPer1M === 0) {
      return imageInput.join(" · ") || "Free";
    }
    return [`${formatModelPrice(inputPer1M)} in · ${formatModelPrice(outputPer1M)} out per 1M`, ...imageInput].join(" · ");
  }
  const image =
    perImage !== undefined
      ? `${imageOutputPer1M ? "≈" : ""}${formatModelPrice(perImage)} / image`
      : `${formatModelPrice(imageOutputPer1M ?? 0)} image out per 1M`;
  return [image, ...(inputPer1M > 0 ? [`${formatModelPrice(inputPer1M)} in per 1M`] : []), ...imageInput].join(" · ");
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
  return `${model.provider} · ${modelPriceLabel(model.pricingKnown === false ? undefined : model.pricing, modelType(model))}`;
}

/**
 * Makes a searchable Select filter from scratch when focused.
 *
 * Select the current label on focus so typing replaces it instead of appending
 * to the selected model's name and id.
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
  const favorites: ComboboxItem[] = [];
  for (const model of models) {
    const item = { value: model.id, label: modelOptionLabel(model) };
    if (model.favorite === true) favorites.push(item);
    else {
      const group = groups.get(model.provider);
      if (group) group.push(item);
      else groups.set(model.provider, [item]);
    }
  }
  return [
    ...leading,
    ...(favorites.length > 0
      ? [
          {
            group: favoriteGroupLabel,
            items: favorites,
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
 * Custom rendering replaces the default check icon, so draw the tick from the
 * `checked` state supplied beside the option.
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
            {modelPriceLabel(model.pricingKnown === false ? undefined : model.pricing, modelType(model))}
          </Text>
        </Group>
      </Group>
    );
  };
}

const EMPTY_LEADING: ComboboxItem[] = [];

export function ModelSelect({ models, leading = EMPTY_LEADING, details, ...props }: Omit<SelectProps, "data" | "renderOption" | "description"> & {
  models: ModelOption[];
  leading?: ComboboxItem[];
  details?: string;
}) {
  const t = useT();
  const stableLeading = leading.length ? leading : EMPTY_LEADING;
  const data = useMemo(() => modelSelectData(models, stableLeading, t("models.favorites")), [models, stableLeading, t]);
  const renderOption = useMemo(() => renderModelOption(models), [models]);
  const selected = useMemo(() => models.find(model => model.id === props.value), [models, props.value]);
  const description = [selected ? modelSummary(selected) : undefined, details].filter(Boolean).join(" · ") || undefined;
  return <Select {...props} data={data} renderOption={renderOption} description={description} {...selectOnFocus} />;
}
