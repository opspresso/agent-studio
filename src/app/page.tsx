import { Button, Group, Text, Title } from "@mantine/core";
import { IconArrowRight } from "@tabler/icons-react";
import { SignInButton } from "@/components/SignInButton";
import { config } from "@/lib/config";
import { getSessionUser } from "@/lib/session";
import type { MessageKey } from "./_i18n/messages/en";
import { getT } from "./_i18n/server";
import { Overview } from "./_components/Overview";
import classes from "./page.module.css";

const WORKFLOW = [
  { title: "home.flow.build", body: "home.flow.buildBody" },
  { title: "home.flow.run", body: "home.flow.runBody" },
  { title: "home.flow.review", body: "home.flow.reviewBody" },
] as const satisfies ReadonlyArray<{ title: MessageKey; body: MessageKey }>;

const BENEFITS = [
  { title: "home.benefit.network", body: "home.benefit.networkBody" },
  { title: "home.benefit.control", body: "home.benefit.controlBody" },
  { title: "home.benefit.evidence", body: "home.benefit.evidenceBody" },
] as const satisfies ReadonlyArray<{ title: MessageKey; body: MessageKey }>;

export default async function Home() {
  const user = await getSessionUser();
  if (user) {
    return <Overview userName={user.name} userEmail={user.email} tier={user.tier} />;
  }

  const t = await getT();

  return (
    <div className={classes.landing}>
      <section className={classes.hero}>
        <div className={classes.heroCopy}>
          <Text className={classes.eyebrow}>{t("home.eyebrow")}</Text>
          <Title order={1} className={classes.headline}>
            {t("home.headline")}{" "}<span>{t("home.headlineAccent")}</span>
          </Title>
          <Text className={classes.lede}>{t("home.lede")}</Text>
          <Group className={classes.actions} gap="sm" wrap="wrap">
            <SignInButton providers={{ ...config.authProviders, password: false }} />
            <Button component="a" href="/guide" variant="default" rightSection={<IconArrowRight size={16} />}>
              {t("nav.guide")}
            </Button>
          </Group>
          <Text className={classes.signInHint}>{t("home.signInHint")}</Text>
        </div>

        <div className={classes.workflow}>
          <div className={classes.workflowHeader}>
            <Text>{t("home.flow.title")}</Text>
            <span>01 / 03</span>
          </div>
          <ol className={classes.workflowList}>
            {WORKFLOW.map(({ title, body }, index) => (
              <li key={title}>
                <span className={classes.stepNumber}>0{index + 1}</span>
                <div>
                  <Text fw={600}>{t(title)}</Text>
                  <Text className={classes.stepBody}>{t(body)}</Text>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className={classes.benefits} aria-labelledby="home-benefits-title">
        <div className={classes.benefitIntro}>
          <Text className={classes.sectionLabel}>{t("home.sectionLabel")}</Text>
          <Title order={2} id="home-benefits-title">{t("home.coverage")}</Title>
          <Text>{t("home.coverageBody")}</Text>
        </div>
        <div className={classes.benefitList}>
          {BENEFITS.map(({ title, body }, index) => (
            <div className={classes.benefit} key={title}>
              <span>0{index + 1}</span>
              <div>
                <Title order={3}>{t(title)}</Title>
                <Text>{t(body)}</Text>
              </div>
            </div>
          ))}
        </div>
      </section>

    </div>
  );
}
