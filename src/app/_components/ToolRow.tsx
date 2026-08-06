"use client";

import { useState } from "react";
import { Badge, Code, Group, Paper, Stack, Text, UnstyledButton } from "@mantine/core";
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import { describeTool, type ToolKind } from "@/app/_lib/toolCalls";
import type { ToolPair } from "@/app/_lib/toolPairs";
import { SUBAGENT_COLOR } from "./badgeColors";
import classes from "./ToolRow.module.css";

/** What each kind of tool row is called and coloured, for the badge on it. */
const TOOL_KIND: Record<ToolKind, { label: string; color: string }> = {
  skill: { label: "Skill", color: "grape" },
  agent: { label: "Agent", color: SUBAGENT_COLOR },
  agents: { label: "Agents", color: SUBAGENT_COLOR },
  image: { label: "Image", color: "teal" },
  tool: { label: "Tool", color: "gray" },
};

/**
 * One tool's traffic: what was asked, and what came back, in a single row that
 * opens. Two rows for one call is what this replaced — see `pairToolTraffic`.
 *
 * The header says *what kind* of thing ran and *which one*, without being
 * opened. Every skill in the system is one `Skill` call and every hand-off is
 * one `transfer_to_agent`, so a row labelled with the tool's own name told the
 * reader a skill had been loaded and never which — the answer was in the
 * arguments, behind a click. Shared by the chat and the playground, which had
 * each grown their own rendering of the same wire format.
 */
export function ToolRow({ pair }: { pair: ToolPair }) {
  const [open, setOpen] = useState(false);
  const done = pair.content !== undefined;
  const described = describeTool(pair.name ?? "tool", pair.args);
  const kind = TOOL_KIND[described.kind] ?? TOOL_KIND.tool;
  return (
    <Paper withBorder radius="md" style={{ overflow: "hidden" }} my={4} w="100%">
      <UnstyledButton onClick={() => setOpen((prev) => !prev)} className={classes.toolToggle}>
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
              via {pair.author}
            </Text>
          )}
          <Text fz="xs" c="dimmed" ml="auto" style={{ whiteSpace: "nowrap" }}>
            {done ? "✅" : "…"}
          </Text>
        </Group>
      </UnstyledButton>
      {open && (
        <Stack gap={0}>
          {pair.args !== undefined && (
            <Code block fz="xs" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {pair.args}
            </Code>
          )}
          {done && (
            <Code block fz="xs" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {pair.content}
            </Code>
          )}
        </Stack>
      )}
    </Paper>
  );
}
