"use client";

import { useState } from "react";
import { Badge, Code, Group, Paper, Stack, Text, UnstyledButton } from "@mantine/core";
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import { describeTool, type ToolKind } from "@/app/_lib/toolCalls";
import { useT } from "@/app/_i18n/provider";
import type { ToolPair } from "@/app/_lib/toolPairs";
import { isToolErrorText } from "@/shared/toolResultStatus";
import { SUBAGENT_COLOR } from "./badgeColors";
import { JsonHighlight } from "./JsonHighlight";
import classes from "./CollapsibleRow.module.css";

/** What each kind of tool row is called and coloured, for the badge on it. */
const TOOL_KIND: Record<ToolKind, { label: string; color: string }> = {
  skill: { label: "Skill", color: "grape" },
  agent: { label: "Agent", color: SUBAGENT_COLOR },
  image: { label: "Image", color: "teal" },
  tool: { label: "Tool", color: "gray" },
};

/**
 * Shared Chat and Playground row for one paired tool call and result.
 * Its header names the Skill, delegated or handoff Agent, image tool or MCP
 * server/tool; expanding reveals the arguments and returned content.
 */
export function ToolRow({ pair }: { pair: ToolPair }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const done = pair.content !== undefined;
  const failed = pair.content !== undefined && isToolErrorText(pair.content);
  const described = describeTool(pair.name ?? "tool", pair.args);
  const kind = TOOL_KIND[described.kind] ?? TOOL_KIND.tool;
  return (
    <Paper withBorder radius="md" style={{ overflow: "hidden" }} my={4} w="100%">
      <UnstyledButton
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className={classes.rowToggle}
        aria-expanded={open}
      >
        <Group gap="xs" wrap="nowrap">
          {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
          <Badge size="xs" color={kind.color} radius="sm">
            {kind.label}
          </Badge>
          {/* Where it came from, then what ran — the server narrows down what
              the tool name means, so it reads better in front of it. */}
          {described.source && (
            <Text fz="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
              {described.source} ·
            </Text>
          )}
          <Text fz="xs" fw={500} style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
            {described.name}
          </Text>
          {pair.author && (
            <Text fz="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
              {t("chat.via", { path: pair.author })}
            </Text>
          )}
          <Text fz="xs" c={failed ? "red" : "dimmed"} ml="auto" style={{ whiteSpace: "nowrap" }}>
            {failed ? "❌" : done ? "✅" : "…"}
          </Text>
        </Group>
      </UnstyledButton>
      {open && (
        <Stack gap={0}>
          {pair.args !== undefined && (
            <Code block fz="xs" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              <JsonHighlight text={pair.args} />
            </Code>
          )}
          {pair.content !== undefined && (
            <Code block fz="xs" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              <JsonHighlight text={pair.content} />
            </Code>
          )}
        </Stack>
      )}
    </Paper>
  );
}
