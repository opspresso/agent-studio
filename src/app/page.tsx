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
  IconFiles,
  IconFolder,
  IconMessageCircle,
  IconPackage,
  IconPhoto,
  IconSearch,
  IconTimeline,
  IconTool,
} from "@tabler/icons-react";
import { SignInButton } from "@/components/SignInButton";
import { getSessionUser } from "@/lib/session";
import type { MessageKey } from "./_i18n/messages/en";
import { getT } from "./_i18n/server";
import { Overview } from "./_components/Overview";
import classes from "./page.module.css";
import { version } from "../../package.json";

/*
 * `label` is the monospace tag over each card — a lowercase technical token
 * that reads the same in both languages, and is not a message key. The title
 * and body are.
 */
const DOMAINS = [
  {
    label: "projects",
    title: "home.domain.projects",
    body: "home.domain.projectsBody",
    Icon: IconFolder,
  },
  {
    label: "agent",
    title: "home.domain.agent",
    body: "home.domain.agentBody",
    Icon: IconRobot,
  },
  {
    label: "mcp",
    title: "home.domain.mcp",
    body: "home.domain.mcpBody",
    Icon: IconTool,
  },
  {
    label: "skills",
    title: "home.domain.skills",
    body: "home.domain.skillsBody",
    Icon: IconBook2,
  },
  {
    label: "plugins",
    title: "home.domain.plugins",
    body: "home.domain.pluginsBody",
    Icon: IconPackage,
  },
  {
    label: "catalog",
    title: "home.domain.catalog",
    body: "home.domain.catalogBody",
    Icon: IconSearch,
  },
  {
    label: "chats",
    title: "home.domain.chats",
    body: "home.domain.chatsBody",
    Icon: IconMessageCircle,
  },
  {
    label: "images",
    title: "home.domain.images",
    body: "home.domain.imagesBody",
    Icon: IconPhoto,
  },
  {
    label: "artifacts",
    title: "home.domain.artifacts",
    body: "home.domain.artifactsBody",
    Icon: IconFiles,
  },
  {
    label: "surfaces",
    title: "home.domain.surfaces",
    body: "home.domain.surfacesBody",
    Icon: IconArrowsShuffle,
  },
  {
    label: "cost",
    title: "home.domain.cost",
    body: "home.domain.costBody",
    Icon: IconChartBar,
  },
  {
    label: "traces",
    title: "home.domain.traces",
    body: "home.domain.tracesBody",
    Icon: IconTimeline,
  },
] as const satisfies ReadonlyArray<{
  label: string;
  title: MessageKey;
  body: MessageKey;
  Icon: typeof IconFolder;
}>;

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
    return <Overview userName={user.name} userEmail={user.email} tier={user.tier} />;
  }

  const t = await getT();

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
            {t("home.eyebrow")}
          </Badge>
          <Title order={1} mt="lg" fz={{ base: 42, md: 60 }} lh={1.04} lts="-0.045em">
            {t("home.headline")}
            <span className={classes.gradientText}>{t("home.headlineAccent")}</span>
          </Title>
          <Text mt="xl" maw={580} c="dimmed" lh={1.7} fz={{ base: "md", md: "lg" }}>
            {t("home.lede")}
          </Text>
          <Group mt="xl" gap="md" wrap="wrap">
            <SignInButton />
            <Text fz="sm" c="dimmed">
              {t("home.signInHint")}
            </Text>
          </Group>
          <Group mt={32} gap="xl" wrap="wrap" className={classes.proofRow}>
            <div>
              <Text fw={650}>{t("home.proof.engine")}</Text>
              <Text fz="xs" c="dimmed">
                {t("home.proof.engineNote")}
              </Text>
            </div>
            <div>
              <Text fw={650}>{t("home.proof.traces")}</Text>
              <Text fz="xs" c="dimmed">
                {t("home.proof.tracesNote")}
              </Text>
            </div>
            <div>
              <Text fw={650}>{t("home.proof.cost")}</Text>
              <Text fz="xs" c="dimmed">
                {t("home.proof.costNote")}
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
              aria-label={t("home.streamLabel")}
            >
              <Group
                component="figcaption"
                justify="space-between"
                px="md"
                py="xs"
                className={classes.consoleHeader}
              >
                <Text ff="monospace" fz="xs" c="dimmed">
                  {t("home.streamCaption")}
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
                  {t("home.streamLive")}
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
              {t("home.agentOnline")}
            </Badge>
          </div>
        </GridCol>
      </Grid>

      <section>
        <VisuallyHidden>
          <Title order={2}>{t("home.coverage")}</Title>
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
                {t(domain.title)}
              </Text>
              <Text fz="sm" c="dimmed" mt={6} lh={1.6}>
                {t(domain.body)}
              </Text>
            </Card>
          ))}
        </SimpleGrid>
      </section>

      <Stack gap={6} align="center">
        <Text ta="center" fz="xs" c="dimmed">
          {t("home.product")}
        </Text>
        <Text ff="monospace" fz={10} c="dimmed" lts="0.12em">
          v{version}
        </Text>
      </Stack>
    </Stack>
  );
}
