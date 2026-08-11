import {
  Badge,
  Card,
  Grid,
  GridCol,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
  VisuallyHidden,
} from "@mantine/core";
import {
  IconArrowsShuffle,
  IconBolt,
  IconBook2,
  IconRobot,
  IconChartBar,
  IconFolder,
  IconMessageCircle,
  IconPackage,
  IconPhoto,
  IconTool,
} from "@tabler/icons-react";
import { SignInButton } from "@/components/SignInButton";
import { getSessionUser } from "@/lib/session";
import { Overview } from "./_components/Overview";
import classes from "./page.module.css";

const DOMAINS = [
  {
    label: "projects",
    title: "Projects & versions",
    body: "Author prompts, agents, and image projects as immutable versions. Publish one; callers pin it or follow the pointer.",
    Icon: IconFolder,
  },
  {
    label: "agent",
    title: "Agent loop",
    body: "A multi-turn tool loop with turn budgets, on-demand skills, and subagent transfers — streamed end to end.",
    Icon: IconRobot,
  },
  {
    label: "mcp",
    title: "MCP tools",
    body: "Register a server once; versions bind it, narrow its tools, and override headers — with per-project OAuth, secrets encrypted at rest.",
    Icon: IconTool,
  },
  {
    label: "skills",
    title: "Skills",
    body: "Markdown behavior packs, listed to the model and loaded only when it asks.",
    Icon: IconBook2,
  },
  {
    label: "plugins",
    title: "Agent Plugins",
    body: "Skills and MCP servers sync from one plugins repo — the source of truth for every name it declares.",
    Icon: IconPackage,
  },
  {
    label: "chats",
    title: "Chats",
    body: "Talk to any agent project — replies stream, tool traffic stays inline, and a run outlives the tab that started it.",
    Icon: IconMessageCircle,
  },
  {
    label: "images",
    title: "Images",
    body: "Draw or edit from a prompt — as a project type, agent builtins, or an image subagent; an edit can address any image the run has seen.",
    Icon: IconPhoto,
  },
  {
    label: "surfaces",
    title: "Slack, A2A & webhooks",
    body: "Per-project Slack bots, A2A in both directions, webhook and schedule triggers — every entry point runs the same engine.",
    Icon: IconArrowsShuffle,
  },
  {
    label: "cost",
    title: "Cost & guards",
    body: "Every call priced from the model registry and rolled up per project, per caller, per day — daily and monthly thresholds warn, then refuse.",
    Icon: IconChartBar,
  },
] as const;

const TRACE_LINES: Array<{ kind: "meta" | "tool" | "text" | "author"; text: string }> = [
  { kind: "meta", text: 'POST /api/projects/support-triage/versions/published/agent' },
  { kind: "text", text: 'data: {"delta":{"content":"Looking at the report…"}}' },
  {
    kind: "tool",
    text: 'data: {"delta":{"toolCalls":[{"id":"call_1","type":"function","function":{"name":"Skill","arguments":"{\\"skill_name\\":\\"triage-rules\\"}"}}]}}',
  },
  {
    kind: "tool",
    text: 'data: {"toolResult":{"toolCallId":"call_1","name":"Skill: triage-rules","content":"# Triage rules…"}}',
  },
  {
    kind: "tool",
    text: 'data: {"delta":{"toolCalls":[{"id":"call_2","type":"function","function":{"name":"transfer_to_agent","arguments":"{\\"agent_name\\":\\"escalation-agent\\",\\"message\\":\\"Rate this crash report.\\"}"}}]}}',
  },
  {
    kind: "author",
    text: 'data: {"author":"escalation-agent","authorPath":["escalation-agent"],"delta":{"content":"Severity: P2"}}',
  },
  {
    kind: "author",
    text: 'data: {"author":"escalation-agent","authorPath":["escalation-agent"],"authorDone":true}',
  },
  {
    kind: "tool",
    text: `data: {"toolResult":{"toolCallId":"call_2","name":"transfer_to_agent: escalation-agent","content":"Transferred to 'escalation-agent'; its answer follows.","displayOnly":true}}`,
  },
  { kind: "text", text: 'data: {"delta":{"content":"Filed as P2 with repro steps."}}' },
  { kind: "meta", text: 'data: {"usage":{"inputTokens":812,"outputTokens":164,"costUsd":0.0031}}' },
  { kind: "meta", text: 'data: {"done":true}' },
];

export default async function Home() {
  const user = await getSessionUser();
  if (user) {
    return <Overview userName={user.name} userEmail={user.email} />;
  }

  return (
    <Stack gap={80} py={{ base: "md", md: 48 }}>
      {/*
        `GridCol`, not `Grid.Col`: this is a server component, and Mantine's
        static sub-components do not survive the RSC boundary — the dotted form
        arrives as `undefined` and the page 500s at render.
      */}
      <Grid gap={40} align="center" style={{ marginInline: 0, width: "100%" }}>
        <GridCol span={{ base: 12, lg: 6 }} style={{ minWidth: 0 }}>
          <Badge
            variant="light"
            color="brand"
            radius="xl"
            size="lg"
            leftSection={<IconBolt size={14} />}
            className={classes.eyebrow}
          >
            Version · publish · run
          </Badge>
          <Title order={1} mt="lg" fz={{ base: 42, md: 60 }} lh={1.04} lts="-0.045em">
            Build an agent once,
            <span className={classes.gradientText}> call it from anywhere.</span>
          </Title>
          <Text mt="xl" maw={580} c="dimmed" lh={1.7} fz={{ base: "md", md: "lg" }}>
            Author a prompt or an agent as a project, iterate in versions, publish one — then call
            it from the console, an OpenAI-compatible API, Slack, a webhook, or another agent.
            Every run attributed, priced, and bounded.
          </Text>
          <Group mt="xl" gap="md" wrap="wrap">
            <SignInButton />
            <Text fz="sm" c="dimmed">
              Your Google account, on one of this deployment&rsquo;s allowed domains.
            </Text>
          </Group>
          <Group mt={32} gap="xl" wrap="wrap" className={classes.proofRow}>
            <div>
              <Text fw={650}>One engine</Text>
              <Text fz="xs" c="dimmed">
                Every model, every surface
              </Text>
            </div>
            <div>
              <Text fw={650}>Live traces</Text>
              <Text fz="xs" c="dimmed">
                Every agent handoff
              </Text>
            </div>
            <div>
              <Text fw={650}>Exact cost</Text>
              <Text fz="xs" c="dimmed">
                Every call attributed
              </Text>
            </div>
          </Group>
        </GridCol>

        <GridCol span={{ base: 12, lg: 6 }} style={{ minWidth: 0 }}>
          <div className={classes.visualStage}>
            <div className={classes.orb} />
            <div className={classes.orbit} />
            <Paper
              component="figure"
              withBorder
              m={0}
              w="100%"
              className={classes.console}
              aria-label="Example agent run stream"
            >
              <Group
                component="figcaption"
                justify="space-between"
                px="md"
                py="xs"
                className={classes.consoleHeader}
              >
                <Text ff="monospace" fz="xs" c="dimmed">
                  agent run · text/event-stream
                </Text>
                <Text
                  ff="monospace"
                  fz={10}
                  tt="uppercase"
                  c="teal"
                  px={8}
                  py={2}
                  className={classes.liveBadge}
                >
                  live
                </Text>
              </Group>
              <pre className={classes.trace}>
                {TRACE_LINES.map((line, i) => (
                  <div key={i} className={classes[line.kind]}>
                    {line.text}
                  </div>
                ))}
                <div className={classes.meta}>
                  data: [DONE]
                  <span className={`trace-cursor ${classes.cursor}`} />
                </div>
              </pre>
            </Paper>
            <Badge className={classes.floatingBadge} color="teal" variant="light" radius="xl">
              ● agent online
            </Badge>
          </div>
        </GridCol>
      </Grid>

      <section>
        <VisuallyHidden>
          <Title order={2}>What Agent Studio covers</Title>
        </VisuallyHidden>
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
          {DOMAINS.map(({ Icon, ...domain }) => (
            <Card
              key={domain.label}
              component="article"
              padding="lg"
              className={classes.domainCard}
            >
              <ThemeIcon variant="light" color="brand" size={42} radius="lg">
                <Icon size={21} stroke={1.7} />
              </ThemeIcon>
              <Text
                ff="monospace"
                fz={10}
                tt="uppercase"
                c="dimmed"
                mt="md"
                style={{ letterSpacing: "0.2em" }}
              >
                {domain.label}
              </Text>
              <Text fz="sm" fw={600} mt="xs">
                {domain.title}
              </Text>
              <Text fz="sm" c="dimmed" mt={6} lh={1.6}>
                {domain.body}
              </Text>
            </Card>
          ))}
        </SimpleGrid>
      </section>

      <Text ta="center" fz="xs" c="dimmed">
        An internal LLM platform for prompt, agent, and cost management.
      </Text>
    </Stack>
  );
}
