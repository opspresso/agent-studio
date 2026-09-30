"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import {
  IconArrowRight, IconArrowUpRight, IconCheck, IconChevronUp,
  IconCode, IconCpu, IconFileText, IconLock, IconMenu2,
  IconMicrophone, IconPlayerPlay, IconPlugConnected,
  IconServer, IconShieldCheck, IconUsers, IconWaveSine, IconX,
} from "@tabler/icons-react";
import { LocaleToggle } from "@/components/LocaleToggle";
import { ThemeToggle } from "@/components/ThemeToggle";
import type { Branding } from "@/shared/branding";
import { useT } from "../../_i18n/provider";
import { ParticleField } from "./ParticleField";
import classes from "../../page.module.css";

const NAVIGATION = [
  { id: "platform", label: "home.nav.platform" },
  { id: "capabilities", label: "home.nav.features" },
  { id: "use-cases", label: "home.nav.useCases" },
  { id: "deployment", label: "home.nav.install" },
] as const;
const FEATURES = [
  { id: "configure", Icon: IconPlugConnected },
  { id: "execute", Icon: IconPlayerPlay },
  { id: "share", Icon: IconUsers },
  { id: "observe", Icon: IconWaveSine },
] as const;
const CASES = [
  { id: "documents", Icon: IconFileText },
  { id: "meetings", Icon: IconMicrophone },
  { id: "operations", Icon: IconServer },
  { id: "development", Icon: IconCode },
] as const;

type LandingBranding = Pick<Branding, "name" | "logoUrl">;

function Brand({ branding }: { branding: LandingBranding }) {
  return <span className={classes.brand}>
    <Image src={branding.logoUrl} alt="" width={32} height={32} priority />
    <span>{branding.name}</span>
  </span>;
}

function Capabilities() {
  const t = useT();
  const [active, setActive] = useState(0);
  return <div className={classes.capabilityList}>{FEATURES.map(({ id, Icon }, index) => (
    <article key={id} className={classes.capability} data-active={active === index}>
      <h3><button type="button" aria-expanded={active === index} aria-controls={`capability-${id}`} onClick={() => setActive(active === index ? -1 : index)}>
        <span>0{index + 1}</span>{t(`home.features.${id}.title`)}<IconArrowUpRight size={24} aria-hidden="true" />
      </button></h3>
      <div id={`capability-${id}`} hidden={active !== index} className={classes.capabilityBody}>
        <p>{t(`home.features.${id}.body`)}</p><Icon size={56} stroke={1} aria-hidden="true" />
      </div>
    </article>
  ))}</div>;
}

function UseCases() {
  const t = useT();
  const [active, setActive] = useState(0);
  const selected = CASES[active]!;
  const tabsRef = useRef<HTMLDivElement>(null);

  return <div>
    <div className={classes.caseTabs} role="tablist" aria-label={t("home.nav.useCases")} ref={tabsRef} onKeyDown={event => {
      const directions: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1 };
      const direction = directions[event.key];
      if (direction === undefined && event.key !== "Home" && event.key !== "End") return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? CASES.length - 1 : (active + direction! + CASES.length) % CASES.length;
      setActive(next);
      tabsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
    }}>
      {CASES.map(({ id, Icon }, index) => <button key={id} type="button" role="tab" id={`case-tab-${id}`} aria-controls={`case-panel-${id}`} aria-selected={active === index} tabIndex={active === index ? 0 : -1} onClick={() => setActive(index)}>
        <Icon size={19} stroke={1.6} /><span>{t(`home.cases.${id}`)}</span><IconArrowUpRight size={16} className={classes.tabArrow} />
      </button>)}
    </div>
    {CASES.map(({ id }, index) => <div key={id} id={`case-panel-${id}`} role="tabpanel" aria-labelledby={`case-tab-${id}`} tabIndex={0} hidden={active !== index} className={classes.casePanel}>
      {active === index && <div className={classes.caseContent}>
        <div className={classes.caseRequest}>
          <span className={classes.microLabel}>{t("home.cases.request")} <span>0{active + 1}</span></span>
          <h3>“{t(`home.cases.${id}.prompt`)}”</h3>
          <span className={classes.exampleLabel}><i /> {t("home.cases.example")}</span>
        </div>
        <div className={classes.caseOutcome}>
          <ol className={classes.caseSteps}>{(["step1", "step2", "step3"] as const).map((step, i) => <li key={step}><span>0{i + 1}</span>{t(`home.cases.${id}.${step}`)}<IconCheck size={14} /></li>)}</ol>
          <div className={classes.resultCard}>
            <span className={classes.microLabel}><selected.Icon size={16} /> {t("home.cases.result")}</span>
            <h4>{t(`home.cases.${id}.result`)}</h4>
            <p>{t(`home.cases.${id}.files`)}</p>
          </div>
        </div>
      </div>}
    </div>)}
    <p className={classes.caseNote}>{t("home.cases.note")}</p>
  </div>;
}

export function LandingPage({ branding }: { branding: LandingBranding }) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  return <div className={classes.landing} id="top">
    <a className={classes.skipLink} href="#main-content" onClick={() => document.getElementById("main-content")?.focus()}>{t("chrome.skipToContent")}</a>
    <header className={classes.header} onKeyDown={event => {
      if (event.key === "Escape" && menuOpen) {
        setMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    }}>
      <div className={classes.headerInner}>
        <a href="#top" aria-label={branding.name} className={classes.brandLink}><Brand branding={branding} /></a>
        <nav aria-label={t("home.nav.platform")} className={classes.desktopNav}>{NAVIGATION.map(({ id, label }) => <a href={`#${id}`} key={id}>{t(label)}</a>)}</nav>
        <div className={classes.headerActions}>
          <LocaleToggle />
          <ThemeToggle />
          <a className={classes.headerCta} href="/login">{t("home.start")}<IconArrowUpRight size={16} /></a>
          <button ref={menuButtonRef} className={classes.menuButton} type="button" aria-controls="landing-navigation" aria-expanded={menuOpen} aria-label={t(menuOpen ? "chrome.closeNavigation" : "chrome.openNavigation")} onClick={() => setMenuOpen(value => !value)}>{menuOpen ? <IconX size={22} /> : <IconMenu2 size={22} />}</button>
        </div>
      </div>
      <nav id="landing-navigation" className={classes.mobileNav} aria-label={t("chrome.openNavigation")} hidden={!menuOpen}>{NAVIGATION.map(({ id, label }, index) => <a href={`#${id}`} key={id} onClick={() => setMenuOpen(false)}><span>0{index + 1}</span>{t(label)}<IconArrowUpRight size={18} /></a>)}</nav>
    </header>

    <main id="main-content" tabIndex={-1}>
      <section className={`${classes.hero} ${classes.container}`} aria-labelledby="hero-title">
        <p className={classes.eyebrow}>{t("home.eyebrow")}</p>
        <div className={classes.heroIntroduction}>
          <h1 id="hero-title">{t("home.headline")}<span>{t("home.headlineAccent")}</span></h1>
          <div className={classes.heroAside}>
            <p className={classes.lede}>{t("home.lede")}</p>
            <div className={classes.actions}>
              <a href="/login" className={classes.primaryButton}>{t("home.start")}<IconArrowUpRight size={20} /></a>
              <a href="/guide" className={classes.textButton}>{t("home.guide")}<IconArrowRight size={18} /></a>
            </div>
          </div>
        </div>
      </section>

      <section id="platform" className={`${classes.platformSection} ${classes.container}`} aria-label={t("home.nav.platform")}>
        <ParticleField branding={branding} />
        <div className={classes.governance}><p><IconShieldCheck size={18} />{t("home.platform.governance")}</p><div>{(["access", "approval", "history", "usage"] as const).map(key => <span key={key}>{t(`home.platform.${key}`)}</span>)}</div></div>
      </section>

      <section id="capabilities" className={`${classes.capabilitiesSection} ${classes.section} ${classes.container}`} aria-labelledby="features-title">
        <div className={classes.capabilitiesIntro}><p className={classes.sectionLabel}>{t("home.features.label")}</p><h2 id="features-title">{t("home.features.title")}</h2><p>{t("home.features.body")}</p></div>
        <Capabilities />
      </section>

      <section id="use-cases" className={`${classes.section} ${classes.container}`} aria-labelledby="cases-title">
        <div className={classes.sectionHeading}><div><p className={classes.sectionLabel}>{t("home.cases.label")}</p><h2 id="cases-title">{t("home.cases.title")}</h2></div><p>{t("home.cases.body")}</p></div>
        <UseCases />
      </section>

      <section id="deployment" className={`${classes.deployment} ${classes.container}`} aria-labelledby="install-title">
        <div className={classes.installCopy}><p className={classes.sectionLabel}>{t("home.install.label")}</p><h2 id="install-title">{t("home.install.title")}</h2><p>{t("home.install.body")}</p><a href="/guide#install" className={classes.textButton}>{t("home.guide")}<IconArrowUpRight size={18} /></a></div>
        <div className={classes.installDiagram}><div className={classes.boundaryLabel}><IconLock size={14} />{t("home.install.boundary")}</div><div className={classes.installCore}><Image src={branding.logoUrl} alt="" width={26} height={26} /><span>{branding.name}</span></div><div className={classes.installNodes}>{[{ key: "network", Icon: IconServer }, { key: "auth", Icon: IconShieldCheck }, { key: "models", Icon: IconCpu }].map(({ key, Icon }) => <div key={key}><Icon size={23} stroke={1.5} /><span>{t(`home.install.${key}` as "home.install.network" | "home.install.auth" | "home.install.models")}</span></div>)}</div><p><i />{t("home.install.private")}</p></div>
      </section>

      <section className={classes.closing} aria-labelledby="cta-title"><div className={classes.container}><h2 id="cta-title">{t("home.cta.title")}</h2><p>{t("home.cta.body")}</p><div className={classes.actions}><a href="/login" className={classes.primaryButton}>{t("home.start")}<IconArrowUpRight size={20} /></a><a href="/guide" className={classes.textButton}>{t("home.guide")}<IconArrowRight size={18} /></a></div></div></section>
    </main>
    <footer className={`${classes.footer} ${classes.container}`}><div className={classes.footerTop}><a href="#top" aria-label={branding.name}><Brand branding={branding} /></a><p>{t("home.footer.description")}</p><a href="#top" className={classes.backToTop}>{t("home.footer.top")}<IconChevronUp size={18} /></a></div><div className={classes.footerBottom}><span>© CLUSH. All rights reserved.</span><a href="/guide">{t("home.guide")}<IconArrowUpRight size={14} /></a></div></footer>
  </div>;
}
