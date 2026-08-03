import {
  Card,
  Grid,
  GridCol,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  Title,
  VisuallyHidden,
} from "@mantine/core";
import { SignInButton } from "@/components/SignInButton";
import { hasSession } from "@/lib/session";
import { Dashboard } from "./_components/Dashboard";
import classes from "./page.module.css";

const DOMAINS = [
  {
    label: "projects",
    title: "Projects & versions",
    body: "Author prompts as versioned configs. Publish one version; callers pin it or follow the pointer.",
  },
  {
    label: "agent",
    title: "Agent loop",
    body: "Multi-turn tool execution with turn budgets, skill loading, and transfer to sub-agents.",
  },
  {
    label: "mcp",
    title: "MCP tools",
    body: "Register MCP servers once; any version can attach their tools, headers encrypted at rest.",
  },
  {
    label: "skills",
    title: "Skills",
    body: "Markdown behavior packs, listed to the model and loaded only when it asks.",
  },
  {
    label: "chats",
    title: "Chats",
    body: "Talk to any agent project over streaming SSE, with tool results inline.",
  },
  {
    label: "images",
    title: "Images",
    body: "Draw or edit images from a prompt — as a project type, as agent builtins, or as an image subagent.",
  },
  {
    label: "surfaces",
    title: "Slack, A2A & webhooks",
    body: "Per-project Slack bots, both A2A directions, webhook triggers — every entry point runs the same engine.",
  },
  {
    label: "cost",
    title: "Cost",
    body: "Every call priced from the model registry and rolled up per project, per caller, per day.",
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
  if (await hasSession()) {
    return <Dashboard />;
  }

  return (
    <Stack gap={64} py="xl">
      {/*
        `GridCol`, not `Grid.Col`: this is a server component, and Mantine's
        static sub-components do not survive the RSC boundary — the dotted form
        arrives as `undefined` and the page 500s at render.
      */}
      <Grid gap={40} align="center">
        <GridCol span={{ base: 12, lg: 6 }}>
          <Text ff="monospace" fz="xs" tt="uppercase" c="brand" style={{ letterSpacing: "0.2em" }}>
            prompt → publish → call
          </Text>
          <Title order={1} mt="md" fz={{ base: 36, md: 48 }} lh={1.15}>
            One studio for prompts, agents, and what they cost.
          </Title>
          <Text mt="lg" maw={560} c="dimmed" lh={1.6}>
            Agent Studio is where a prompt becomes a published version, a version becomes an agent
            with tools, and every call lands in a cost report. Built for teams that run LLM
            workloads in production.
          </Text>
          <Group mt="xl" gap="md" wrap="wrap">
            <SignInButton />
            <Text fz="sm" c="dimmed">
              Sign-in required for the whole workspace.
            </Text>
          </Group>
        </GridCol>

        <GridCol span={{ base: 12, lg: 6 }}>
          <Paper
            component="figure"
            withBorder
            radius="md"
            m={0}
            style={{ overflow: "hidden" }}
            aria-label="Example agent run stream"
          >
            <Group
              component="figcaption"
              justify="space-between"
              px="md"
              py="xs"
              style={{
                borderBottom: "1px solid var(--mantine-color-default-border)",
              }}
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
                style={{
                  letterSpacing: "0.1em",
                  borderRadius: "var(--mantine-radius-xl)",
                  backgroundColor: "var(--mantine-color-teal-light)",
                }}
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
        </GridCol>
      </Grid>

      <section>
        <VisuallyHidden>
          <Title order={2}>What Agent Studio covers</Title>
        </VisuallyHidden>
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
          {DOMAINS.map((domain) => (
            <Card key={domain.label} component="article" padding="lg">
              <Text
                ff="monospace"
                fz={10}
                tt="uppercase"
                c="dimmed"
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
