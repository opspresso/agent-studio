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
  IconPhoto,
  IconTool,
} from "@tabler/icons-react";
import { SignInButton } from "@/components/SignInButton";
import { getSessionUser } from "@/lib/session";
import { Dashboard } from "./_components/Dashboard";
import classes from "./page.module.css";

const DOMAINS = [
  {
    label: "projects",
    title: "Projects & versions",
    body: "Author prompts as versioned configs. Publish one version; callers pin it or follow the pointer.",
    Icon: IconFolder,
  },
  {
    label: "agent",
    title: "Agent loop",
    body: "Multi-turn tool execution with turn budgets, skill loading, and transfer to sub-agents.",
    Icon: IconRobot,
  },
  {
    label: "mcp",
    title: "MCP tools",
    body: "Register MCP servers once; any version can attach their tools, headers encrypted at rest.",
    Icon: IconTool,
  },
  {
    label: "skills",
    title: "Skills",
    body: "Markdown behavior packs, listed to the model and loaded only when it asks.",
    Icon: IconBook2,
  },
  {
    label: "chats",
    title: "Chats",
    body: "Talk to any agent project over streaming SSE, with tool results inline.",
    Icon: IconMessageCircle,
  },
  {
    label: "images",
    title: "Images",
    body: "Draw or edit images from a prompt — as a project type, as agent builtins, or as an image subagent.",
    Icon: IconPhoto,
  },
  {
    label: "surfaces",
    title: "Slack, A2A & webhooks",
    body: "Per-project Slack bots, both A2A directions, webhook triggers — every entry point runs the same engine.",
    Icon: IconArrowsShuffle,
  },
  {
    label: "cost",
    title: "Cost",
    body: "Every call priced from the model registry and rolled up per project, per caller, per day.",
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
    return <Dashboard />;
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
            Build · orchestrate · observe
          </Badge>
          <Title order={1} mt="lg" fz={{ base: 42, md: 60 }} lh={1.04} lts="-0.045em">
            Your AI systems,
            <span className={classes.gradientText}> finally in one studio.</span>
          </Title>
          <Text mt="xl" maw={580} c="dimmed" lh={1.7} fz={{ base: "md", md: "lg" }}>
            Design prompts, connect tools, coordinate agents, and understand every run from one
            production workspace.
          </Text>
          <Group mt="xl" gap="md" wrap="wrap">
            <SignInButton />
            <Text fz="sm" c="dimmed">
              Secure access for your entire AI workspace.
            </Text>
          </Group>
          <Group mt={32} gap="xl" wrap="wrap" className={classes.proofRow}>
            <div>
              <Text fw={650}>One runtime</Text>
              <Text fz="xs" c="dimmed">
                Every model and surface
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
        Next.js · DynamoDB · OpenAI-compatible channels for every model
      </Text>
    </Stack>
  );
}
