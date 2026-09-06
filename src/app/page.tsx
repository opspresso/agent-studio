import {
  Badge,
  Button,
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
} from "@mantine/core";
import {
  IconArrowsShuffle,
  IconArrowDown,
  IconPlayerPlay,
  IconVersions,
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
import { config } from "@/lib/config";
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

const WORKFLOW = [
  { title: "home.flow.build", body: "home.flow.buildBody", Icon: IconFolder },
  { title: "home.flow.run", body: "home.flow.runBody", Icon: IconPlayerPlay },
  { title: "home.flow.review", body: "home.flow.reviewBody", Icon: IconFiles },
] as const satisfies ReadonlyArray<{ title: MessageKey; body: MessageKey; Icon: typeof IconFolder }>;

export default async function Home() {
  const user = await getSessionUser();
  if (user) {
    return <Overview userName={user.name} userEmail={user.email} tier={user.tier} />;
  }

  const t = await getT();

  return (
    <Stack gap={56} py={{ base: "md", md: 32 }}>
      {/*
        `GridCol`, not `Grid.Col`: this is a server component, and Mantine's
        static sub-components do not survive the RSC boundary — the dotted form
        arrives as `undefined` and the page 500s at render.
      */}
      <Grid gap={40} align="center" style={{ marginInline: 0, width: "100%" }}>
        <GridCol span={{ base: 12, lg: 6 }} className={classes.hero} style={{ minWidth: 0 }}>
          <Badge
            variant="light"
            color="brand"
            radius="xl"
            size="lg"
            leftSection={<IconVersions size={14} />}
            className={classes.eyebrow}
          >
            {t("home.eyebrow")}
          </Badge>
          <Title order={1} mt="lg" fz={{ base: 36, md: 48 }} lh={1.12} lts="-0.045em">
            {t("home.headline")}
            <span className={classes.gradientText}>{t("home.headlineAccent")}</span>
          </Title>
          <Text mt="lg" maw={580} c="dimmed" lh={1.7} fz="md">
            {t("home.lede")}
          </Text>
          <Group mt="xl" gap="md" wrap="wrap">
            <SignInButton providers={{ ...config.authProviders, password: false }} />
            <Button component="a" href="/guide" variant="default">
              {t("nav.guide")}
            </Button>
            <Text fz="sm" c="dimmed">
              {t("home.signInHint")}
            </Text>
          </Group>
          <Group mt={32} gap="xl" wrap="wrap" className={classes.proofRow}>
            <div>
              <Text fw={650}>{t("home.proof.network")}</Text>
              <Text fz="xs" c="dimmed">
                {t("home.proof.networkNote")}
              </Text>
            </div>
            <div>
              <Text fw={650}>{t("home.proof.engine")}</Text>
              <Text fz="xs" c="dimmed">
                {t("home.proof.engineNote")}
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
          <Paper component="figure" withBorder m={0} p={{ base: "lg", md: "xl" }} className={classes.workflow}>
            <Text component="figcaption" fw={600} fz="lg" mb="xl">
              {t("home.flow.title")}
            </Text>
            <Stack gap="sm">
              {WORKFLOW.map(({ title, body, Icon }, index) => (
                <div key={title}>
                  {index > 0 && <IconArrowDown size={18} className={classes.flowArrow} aria-hidden="true" />}
                  <Group align="flex-start" wrap="nowrap" gap="md" className={classes.flowStep}>
                    <ThemeIcon size={44} variant="light" color="brand" radius="lg" style={{ flexShrink: 0 }}>
                      <Icon size={22} stroke={1.7} />
                    </ThemeIcon>
                    <div>
                      <Text fz="xs" c="dimmed" mb={2}>0{index + 1}</Text>
                      <Text fw={600}>{t(title)}</Text>
                      <Text fz="sm" c="dimmed" mt={5} lh={1.6}>{t(body)}</Text>
                    </div>
                  </Group>
                </div>
              ))}
            </Stack>
          </Paper>
        </GridCol>
      </Grid>

      <section>
        <Title order={2} fz="h3" mb="lg">{t("home.coverage")}</Title>
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
              <Title order={3} fz="md" fw={600} mt="xs">
                {t(domain.title)}
              </Title>
              <Text fz="sm" c="dimmed" mt={6} lh={1.6}>
                {t(domain.body)}
              </Text>
            </Card>
          ))}
        </SimpleGrid>
      </section>

      <Paper
        component="section"
        withBorder
        radius="lg"
        p={{ base: "lg", md: "xl" }}
        className={classes.guidePanel}
      >
        <Title order={2} fz="h3">
          {t("home.guide.title")}
        </Title>
        <Text mt="sm" maw={760} c="dimmed" lh={1.7}>
          {t("home.guide.body")}
        </Text>
        <Button component="a" href="/guide" mt="lg" variant="default">
          {t("nav.guide")}
        </Button>
      </Paper>

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
