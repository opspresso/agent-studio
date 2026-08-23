import { Card, Group, SimpleGrid, Stack, Text, ThemeIcon, Title } from "@mantine/core";
import {
  IconBook2,
  IconCompass,
  IconCoin,
  IconLifebuoy,
  IconPlugConnected,
  IconRoute,
  IconVocabulary,
} from "@tabler/icons-react";
import type { TablerIcon } from "@tabler/icons-react";
import { PageHeader } from "@/app/_components/PageHeader";
import type { MessageKey } from "@/app/_i18n/messages/en";
import { getT } from "@/app/_i18n/server";

/**
 * The one page whose content *is* its text: what this console is for and the
 * shortest path through it, for a reader who has just been given an account.
 *
 * A server component, so the prose is rendered in the reader's language on the
 * first paint rather than after hydration — this page is nothing but strings,
 * and a flash of the wrong language would be the whole page. Nothing here is
 * interactive, which is what makes that free.
 *
 * Every entry below is a pair of message keys, and the page is the seven lists.
 * That is deliberate: a section is added by writing its two catalogue entries
 * and one array element, so the English and Korean copies stay in step through
 * `Messages` rather than through anyone remembering to edit twice. No dotted
 * Mantine sub-component (`List.Item`, `Card.Section`) appears here — they do
 * not survive the RSC boundary and arrive as `undefined`, which is a 500 at
 * render rather than a mistake anyone sees while writing.
 */

interface Entry {
  title: MessageKey;
  body: MessageKey;
}

const STEPS = [
  { title: "guide.start.step1", body: "guide.start.step1Body" },
  { title: "guide.start.step2", body: "guide.start.step2Body" },
  { title: "guide.start.step3", body: "guide.start.step3Body" },
  { title: "guide.start.step4", body: "guide.start.step4Body" },
] as const satisfies readonly Entry[];

const WORDS = [
  { title: "guide.words.project", body: "guide.words.projectBody" },
  { title: "guide.words.version", body: "guide.words.versionBody" },
  { title: "guide.words.run", body: "guide.words.runBody" },
  { title: "guide.words.caller", body: "guide.words.callerBody" },
  { title: "guide.words.tier", body: "guide.words.tierBody" },
] as const satisfies readonly Entry[];

const TYPES = [
  { title: "guide.types.llm", body: "guide.types.llmBody" },
  { title: "guide.types.agent", body: "guide.types.agentBody" },
  { title: "guide.types.image", body: "guide.types.imageBody" },
] as const satisfies readonly Entry[];

const REACH = [
  { title: "guide.reach.skills", body: "guide.reach.skillsBody" },
  { title: "guide.reach.tools", body: "guide.reach.toolsBody" },
  { title: "guide.reach.subagents", body: "guide.reach.subagentsBody" },
  { title: "guide.reach.catalog", body: "guide.reach.catalogBody" },
  { title: "guide.reach.builtins", body: "guide.reach.builtinsBody" },
  { title: "guide.reach.memory", body: "guide.reach.memoryBody" },
] as const satisfies readonly Entry[];

const SURFACES = [
  { title: "guide.surfaces.console", body: "guide.surfaces.consoleBody" },
  { title: "guide.surfaces.http", body: "guide.surfaces.httpBody" },
  { title: "guide.surfaces.chatbots", body: "guide.surfaces.chatbotsBody" },
  { title: "guide.surfaces.triggers", body: "guide.surfaces.triggersBody" },
  { title: "guide.surfaces.a2a", body: "guide.surfaces.a2aBody" },
  { title: "guide.surfaces.agui", body: "guide.surfaces.aguiBody" },
] as const satisfies readonly Entry[];

const LIMITS = [
  { title: "guide.limits.cost", body: "guide.limits.costBody" },
  { title: "guide.limits.guards", body: "guide.limits.guardsBody" },
  { title: "guide.limits.tier", body: "guide.limits.tierBody" },
  { title: "guide.limits.records", body: "guide.limits.recordsBody" },
] as const satisfies readonly Entry[];

const TROUBLE = [
  { title: "guide.trouble.refused", body: "guide.trouble.refusedBody" },
  { title: "guide.trouble.model", body: "guide.trouble.modelBody" },
  { title: "guide.trouble.tool", body: "guide.trouble.toolBody" },
  { title: "guide.trouble.slack", body: "guide.trouble.slackBody" },
  { title: "guide.trouble.tab", body: "guide.trouble.tabBody" },
] as const satisfies readonly Entry[];

export default async function GuidePage() {
  const t = await getT();

  /*
   * A section, and the two shapes its entries take. Locals rather than
   * exported components: nothing outside this page draws a guide section, and
   * a shared one would have to grow a prop for each of the differences below.
   */
  const section = (
    heading: MessageKey,
    Icon: TablerIcon,
    lede: MessageKey | null,
    children: React.ReactNode,
  ) => (
    <Card component="section" padding="lg">
      <Group gap="sm" wrap="nowrap" align="center">
        <ThemeIcon variant="light" color="brand" size={34} radius="md">
          <Icon size={19} stroke={1.7} />
        </ThemeIcon>
        <Title order={2} fz="h4">
          {t(heading)}
        </Title>
      </Group>
      {lede && (
        <Text fz="sm" c="dimmed" mt="sm" maw={820} lh={1.6}>
          {t(lede)}
        </Text>
      )}
      {children}
    </Card>
  );

  const entries = (items: readonly Entry[]) => (
    <Stack gap="md" mt="lg">
      {items.map((entry) => (
        <div key={entry.title}>
          <Text fz="sm" fw={600}>
            {t(entry.title)}
          </Text>
          <Text fz="sm" c="dimmed" mt={4} maw={820} lh={1.6}>
            {t(entry.body)}
          </Text>
        </div>
      ))}
    </Stack>
  );

  return (
    <Stack gap="lg">
      <PageHeader title={t("guide.title")} description={t("guide.lede")} Icon={IconCompass} />

      {section(
        "guide.start.title",
        IconRoute,
        "guide.start.body",
        <Stack gap="md" mt="lg">
          {STEPS.map((step, index) => (
            <Group key={step.title} gap="md" wrap="nowrap" align="flex-start">
              {/* The step number is the ordering, so it is drawn rather than implied. */}
              <ThemeIcon variant="light" color="brand" size={28} radius="xl">
                <Text fz="xs" fw={700}>
                  {index + 1}
                </Text>
              </ThemeIcon>
              <div style={{ minWidth: 0 }}>
                <Text fz="sm" fw={600}>
                  {t(step.title)}
                </Text>
                <Text fz="sm" c="dimmed" mt={4} maw={820} lh={1.6}>
                  {t(step.body)}
                </Text>
              </div>
            </Group>
          ))}
        </Stack>,
      )}

      {section("guide.words.title", IconVocabulary, null, entries(WORDS))}

      {section(
        "guide.types.title",
        IconBook2,
        null,
        <SimpleGrid cols={{ base: 1, md: 3 }} spacing="lg" mt="lg">
          {TYPES.map((type) => (
            <div key={type.title}>
              <Text fz="sm" fw={600} ff="monospace">
                {t(type.title)}
              </Text>
              <Text fz="sm" c="dimmed" mt={6} lh={1.6}>
                {t(type.body)}
              </Text>
            </div>
          ))}
        </SimpleGrid>,
      )}

      {section("guide.reach.title", IconPlugConnected, "guide.reach.body", entries(REACH))}

      {section("guide.surfaces.title", IconRoute, "guide.surfaces.body", entries(SURFACES))}

      {section("guide.limits.title", IconCoin, null, entries(LIMITS))}

      {section("guide.trouble.title", IconLifebuoy, null, entries(TROUBLE))}

      {section("guide.more.title", IconBook2, "guide.more.body", null)}
    </Stack>
  );
}
