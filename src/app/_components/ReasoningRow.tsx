"use client";

import { useState } from "react";
import { Group, Paper, Text, UnstyledButton } from "@mantine/core";
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import { useLocale, useT } from "@/app/_i18n/provider";
import classes from "./CollapsibleRow.module.css";

/**
 * A run's own thinking, in a row that opens.
 *
 * Only an Agent that asked for it (`parameters.reasoningTrace`) produces any,
 * so a row rendered at all is one the author opted into. Shared by the chat and
 * the playground for the reason `ToolRow` is: the same wire text grown twice is
 * two renderings that drift.
 *
 * Prose, not JSON — no highlighting, and `Text` rather than `Code` so a long
 * think costs a paragraph to draw rather than a re-parse per frame. It is
 * deliberately not a scroll container on both axes: `use-stick-to-bottom` walks
 * up from the pointer to the first element whose `overflow` is `auto`, and one
 * that is both would swallow the wheel the chat thread follows.
 */
export function ReasoningRow({
  text,
  tokens,
  streaming,
}: {
  text: string;
  /** Reasoning tokens the provider reported, when it reported any. */
  tokens?: number | undefined;
  /** Thinking is arriving and the answer has not started — show it. */
  streaming?: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  // Until the reader says otherwise, the run decides: open while it thinks,
  // closed once the answer starts. After a click it is the reader's, because
  // collapsing a block out from under someone who opened it is the bug.
  const [touched, setTouched] = useState(false);
  const [open, setOpen] = useState(false);
  const shown = touched ? open : streaming === true;
  if (!text) {
    // Nothing is drawn from a count alone. An Agent that did not opt in still
    // produces one — `toUsageInfo` reports whatever the provider says, and only
    // the *yield* is gated — so this branch cannot tell that run from one whose
    // provider reports a count and streams no thinking. The engine can, and
    // says so as a warning on the run itself.
    return null;
  }
  return (
    <Paper withBorder radius="md" style={{ overflow: "hidden" }} my={4} w="100%">
      <UnstyledButton
        type="button"
        onClick={() => {
          setTouched(true);
          setOpen(!shown);
        }}
        className={classes.rowToggle}
        aria-expanded={shown}
      >
        <Group gap="xs" wrap="nowrap">
          {shown ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
          <Text fz="xs" fw={500}>
            🧠 {t("common.reasoning")}
          </Text>
          {tokens !== undefined && (
            <Text fz="xs" c="dimmed" ml="auto" style={{ whiteSpace: "nowrap" }}>
              {t("common.reasoningTokens", { count: tokens.toLocaleString(locale) })}
            </Text>
          )}
        </Group>
      </UnstyledButton>
      {shown && (
        <Text
          fz="xs"
          c="dimmed"
          px="sm"
          py={6}
          style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
        >
          {text}
        </Text>
      )}
    </Paper>
  );
}
