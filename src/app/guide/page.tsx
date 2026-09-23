import Link from "next/link";
import { Card, Group, Stack, Text, ThemeIcon, Title } from "@mantine/core";
import {
  IconBook2,
  IconCompass,
  IconCoin,
  IconLifebuoy,
  IconMicrophone,
  IconPlugConnected,
  IconRoute,
  IconVocabulary,
  IconTerminal2,
} from "@tabler/icons-react";
import type { TablerIcon } from "@tabler/icons-react";
import { PageHeader } from "@/app/_components/PageHeader";
import type { MessageKey } from "@/app/_i18n/messages/en";
import { getT } from "@/app/_i18n/server";
import classes from "./page.module.css";

interface GuideSection {
  id: string;
  title: MessageKey;
  body?: MessageKey;
  Icon: TablerIcon;
  entries: ReadonlyArray<{ title: MessageKey; body: MessageKey }>;
  links?: ReadonlyArray<{ href: string; label: MessageKey }>;
}

const SECTIONS: readonly GuideSection[] = [
  {
    id: "start",
    title: "guide.start.title",
    body: "guide.start.body",
    Icon: IconCompass,
    entries: [
      { title: "guide.start.account", body: "guide.start.accountBody" },
      { title: "guide.start.create", body: "guide.start.createBody" },
      { title: "guide.start.test", body: "guide.start.testBody" },
      { title: "guide.start.connect", body: "guide.start.connectBody" },
    ],
    links: [
      { href: "/chats", label: "nav.chats" },
      { href: "/projects", label: "nav.projects" },
      { href: "/profile", label: "nav.profile" },
    ],
  },
  {
    id: "projects",
    title: "guide.projects.title",
    body: "guide.projects.body",
    Icon: IconBook2,
    entries: [
      { title: "guide.projects.agent", body: "guide.projects.agentBody" },
      { title: "guide.projects.image", body: "guide.projects.imageBody" },
    ],
    links: [
      { href: "/projects", label: "nav.projects" },
    ],
  },
  {
    id: "configuration",
    title: "guide.configuration.title",
    body: "guide.configuration.body",
    Icon: IconRoute,
    entries: [
      { title: "guide.configuration.model", body: "guide.configuration.modelBody" },
      { title: "guide.configuration.prompt", body: "guide.configuration.promptBody" },
      { title: "guide.configuration.limits", body: "guide.configuration.limitsBody" },
      { title: "guide.configuration.apply", body: "guide.configuration.applyBody" },
    ],
  },
  {
    id: "capabilities",
    title: "guide.capabilities.title",
    body: "guide.capabilities.body",
    Icon: IconPlugConnected,
    entries: [
      { title: "guide.capabilities.skills", body: "guide.capabilities.skillsBody" },
      { title: "guide.capabilities.tools", body: "guide.capabilities.toolsBody" },
      { title: "guide.capabilities.oauth", body: "guide.capabilities.oauthBody" },
      { title: "guide.capabilities.agents", body: "guide.capabilities.agentsBody" },
      { title: "guide.capabilities.plugins", body: "guide.capabilities.pluginsBody" },
      { title: "guide.capabilities.discovery", body: "guide.capabilities.discoveryBody" },
      { title: "guide.capabilities.builtins", body: "guide.capabilities.builtinsBody" },
    ],
    links: [
      { href: "/skills", label: "nav.skills" },
      { href: "/tools", label: "nav.tools" },
      { href: "/agents", label: "nav.agents" },
      { href: "/plugins", label: "nav.plugins" },
    ],
  },
  {
    id: "chat",
    title: "guide.chat.title",
    body: "guide.chat.body",
    Icon: IconVocabulary,
    entries: [
      { title: "guide.chat.configuration", body: "guide.chat.configurationBody" },
      { title: "guide.chat.context", body: "guide.chat.contextBody" },
      { title: "guide.chat.attachments", body: "guide.chat.attachmentsBody" },
      { title: "guide.chat.createFiles", body: "guide.chat.createFilesBody" },
      { title: "guide.chat.editFiles", body: "guide.chat.editFilesBody" },
      { title: "guide.chat.fileLimits", body: "guide.chat.fileLimitsBody" },
      { title: "guide.chat.stop", body: "guide.chat.stopBody" },
      { title: "guide.chat.approvals", body: "guide.chat.approvalsBody" },
    ],
    links: [
      { href: "/chats", label: "nav.chats" },
      { href: "/artifacts", label: "nav.artifacts" },
    ],
  },
  {
    id: "workspaces",
    title: "guide.workspaces.title",
    body: "guide.workspaces.body",
    Icon: IconTerminal2,
    entries: [
      { title: "guide.workspaces.setup", body: "guide.workspaces.setupBody" },
      { title: "guide.workspaces.tasks", body: "guide.workspaces.tasksBody" },
      { title: "guide.workspaces.reuse", body: "guide.workspaces.reuseBody" },
      { title: "guide.workspaces.runtime", body: "guide.workspaces.runtimeBody" },
      { title: "guide.workspaces.repository", body: "guide.workspaces.repositoryBody" },
      { title: "guide.workspaces.approvals", body: "guide.workspaces.approvalsBody" },
      { title: "guide.workspaces.results", body: "guide.workspaces.resultsBody" },
      { title: "guide.workspaces.lifecycle", body: "guide.workspaces.lifecycleBody" },
    ],
    links: [{ href: "/chats", label: "nav.chats" }, { href: "/projects", label: "nav.projects" }],
  },
  {
    id: "execution-surfaces",
    title: "guide.surfaces.title",
    body: "guide.surfaces.body",
    Icon: IconRoute,
    entries: [
      { title: "guide.surfaces.chat", body: "guide.surfaces.chatBody" },
      { title: "guide.surfaces.api", body: "guide.surfaces.apiBody" },
      { title: "guide.surfaces.bots", body: "guide.surfaces.botsBody" },
      { title: "guide.surfaces.automation", body: "guide.surfaces.automationBody" },
    ],
  },
  {
    id: "audio",
    title: "guide.audio.title",
    body: "guide.audio.body",
    Icon: IconMicrophone,
    entries: [
      { title: "guide.audio.setup", body: "guide.audio.setupBody" },
      { title: "guide.audio.skills", body: "guide.audio.skillsBody" },
      { title: "guide.audio.configuration", body: "guide.audio.configurationBody" },
      { title: "guide.audio.run", body: "guide.audio.runBody" },
      { title: "guide.audio.results", body: "guide.audio.resultsBody" },
      { title: "guide.audio.records", body: "guide.audio.recordsBody" },
      { title: "guide.audio.retry", body: "guide.audio.retryBody" },
      { title: "guide.audio.reset", body: "guide.audio.resetBody" },
    ],
    links: [
      { href: "/projects", label: "nav.projects" },
      { href: "/artifacts", label: "nav.artifacts" },
    ],
  },
  {
    id: "api",
    title: "guide.api.title",
    body: "guide.api.body",
    Icon: IconRoute,
    entries: [
      { title: "guide.api.token", body: "guide.api.tokenBody" },
      { title: "guide.api.address", body: "guide.api.addressBody" },
      { title: "guide.api.input", body: "guide.api.inputBody" },
      { title: "guide.api.sdk", body: "guide.api.sdkBody" },
      { title: "guide.api.stream", body: "guide.api.streamBody" },
      { title: "guide.api.result", body: "guide.api.resultBody" },
    ],
    links: [
      { href: "/projects", label: "nav.projects" },
    ],
  },
  {
    id: "integrations",
    title: "guide.integrations.title",
    body: "guide.integrations.body",
    Icon: IconPlugConnected,
    entries: [
      { title: "guide.integrations.slack", body: "guide.integrations.slackBody" },
      { title: "guide.integrations.messengers", body: "guide.integrations.messengersBody" },
      { title: "guide.integrations.webhook", body: "guide.integrations.webhookBody" },
      { title: "guide.integrations.schedule", body: "guide.integrations.scheduleBody" },
    ],
  },
  {
    id: "records",
    title: "guide.records.title",
    Icon: IconCoin,
    entries: [
      { title: "guide.records.artifacts", body: "guide.records.artifactsBody" },
      { title: "guide.records.usage", body: "guide.records.usageBody" },
      { title: "guide.records.budgets", body: "guide.records.budgetsBody" },
      { title: "guide.records.traces", body: "guide.records.tracesBody" },
    ],
    links: [
      { href: "/artifacts", label: "nav.artifacts" },
      { href: "/profile", label: "nav.profile" },
      { href: "/projects", label: "nav.projects" },
    ],
  },
  {
    id: "security",
    title: "guide.security.title",
    body: "guide.security.body",
    Icon: IconBook2,
    entries: [
      { title: "guide.security.visibility", body: "guide.security.visibilityBody" },
      { title: "guide.security.credentials", body: "guide.security.credentialsBody" },
      { title: "guide.security.pii", body: "guide.security.piiBody" },
      { title: "guide.security.network", body: "guide.security.networkBody" },
    ],
    links: [
      { href: "/profile", label: "nav.profile" },
    ],
  },
  {
    id: "admin",
    title: "guide.admin.title",
    body: "guide.admin.body",
    Icon: IconVocabulary,
    entries: [
      { title: "guide.admin.members", body: "guide.admin.membersBody" },
      { title: "guide.admin.settings", body: "guide.admin.settingsBody" },
      { title: "guide.admin.models", body: "guide.admin.modelsBody" },
      { title: "guide.admin.modelSelection", body: "guide.admin.modelSelectionBody" },
      { title: "guide.admin.offline", body: "guide.admin.offlineBody" },
      { title: "guide.admin.artifacts", body: "guide.admin.artifactsBody" },
      { title: "guide.admin.audit", body: "guide.admin.auditBody" },
    ],
    links: [
      { href: "/members", label: "nav.members" },
      { href: "/settings", label: "nav.settings" },
      { href: "/models", label: "nav.models" },
      { href: "/audit", label: "nav.audit" },
    ],
  },
  {
    id: "install",
    title: "guide.install.title",
    body: "guide.install.body",
    Icon: IconBook2,
    entries: [
      { title: "guide.install.prepare", body: "guide.install.prepareBody" },
      { title: "guide.install.environment", body: "guide.install.environmentBody" },
      { title: "guide.install.signin", body: "guide.install.signinBody" },
      { title: "guide.install.storage", body: "guide.install.storageBody" },
      { title: "guide.install.verify", body: "guide.install.verifyBody" },
    ],
  },
  {
    id: "operations",
    title: "guide.operations.title",
    body: "guide.operations.body",
    Icon: IconRoute,
    entries: [
      { title: "guide.operations.health", body: "guide.operations.healthBody" },
      { title: "guide.operations.ticker", body: "guide.operations.tickerBody" },
      { title: "guide.operations.catalog", body: "guide.operations.catalogBody" },
      { title: "guide.operations.retention", body: "guide.operations.retentionBody" },
      { title: "guide.operations.backup", body: "guide.operations.backupBody" },
      { title: "guide.operations.upgrade", body: "guide.operations.upgradeBody" },
    ],
  },
  {
    id: "trouble",
    title: "guide.trouble.title",
    body: "guide.trouble.body",
    Icon: IconLifebuoy,
    entries: [
      { title: "guide.trouble.access", body: "guide.trouble.accessBody" },
      { title: "guide.trouble.model", body: "guide.trouble.modelBody" },
      { title: "guide.trouble.limits", body: "guide.trouble.limitsBody" },
      { title: "guide.trouble.tools", body: "guide.trouble.toolsBody" },
      { title: "guide.trouble.automation", body: "guide.trouble.automationBody" },
      { title: "guide.trouble.files", body: "guide.trouble.filesBody" },
      { title: "guide.trouble.support", body: "guide.trouble.supportBody" },
    ],
  },
];

export default async function GuidePage() {
  const t = await getT();

  return (
    <Stack gap="lg">
      <PageHeader title={t("guide.title")} description={t("guide.lede")} Icon={IconCompass} />

      <nav aria-label={t("guide.contents")}>
        <Group gap="md" wrap="wrap">
          {SECTIONS.map((section) => (
            <a key={section.id} href={`#${section.id}`} className={classes.link}>
              {t(section.title)}
            </a>
          ))}
        </Group>
      </nav>

      {SECTIONS.map(({ id, title, body, Icon, entries, links }) => (
        <Card
          key={id}
          component="section"
          id={id}
          aria-labelledby={`${id}-title`}
          padding="lg"
          className={classes.prose}
        >
          <Group gap="sm" wrap="nowrap" align="center">
            <ThemeIcon variant="light" color="brand" size={34} radius="md">
              <Icon size={19} stroke={1.7} aria-hidden="true" />
            </ThemeIcon>
            <Title id={`${id}-title`} order={2} fz="h4">
              {t(title)}
            </Title>
          </Group>
          {body && (
            <Text fz="sm" c="dimmed" mt="sm" maw={820} lh={1.7}>
              {t(body)}
            </Text>
          )}
          <Stack gap="lg" mt="lg">
            {entries.map((entry) => (
              <div key={entry.title}>
                <Title order={3} fz="sm" fw={600}>
                  {t(entry.title)}
                </Title>
                <Text fz="sm" c="dimmed" mt={4} maw={820} lh={1.7}>
                  {t(entry.body)}
                </Text>
              </div>
            ))}
          </Stack>
          {links && (
            <Group gap="sm" mt="lg">
              {links.map((link) => (
                <Link key={link.href} href={link.href} className={classes.link}>
                  {t(link.label)} →
                </Link>
              ))}
            </Group>
          )}
        </Card>
      ))}
    </Stack>
  );
}
