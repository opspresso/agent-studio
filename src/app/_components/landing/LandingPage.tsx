"use client";

import { useEffect, useRef, useState } from "react";
import {
  IconArrowDown, IconArrowRight, IconArrowUpRight, IconCheck, IconChevronUp,
  IconCode, IconCpu, IconFileText, IconGitBranch, IconLock, IconMenu2,
  IconMessageCircle, IconMicrophone, IconPlayerPlay, IconPlugConnected,
  IconServer, IconShieldCheck, IconSparkles, IconUsers, IconWaveSine, IconX,
} from "@tabler/icons-react";
import { LocaleToggle } from "@/components/LocaleToggle";
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
  { id: "configure", Icon: IconPlugConnected, tag: "CONFIGURE" },
  { id: "execute", Icon: IconPlayerPlay, tag: "EXECUTE" },
  { id: "share", Icon: IconUsers, tag: "COLLABORATE" },
  { id: "observe", Icon: IconWaveSine, tag: "OBSERVE" },
] as const;
const CASES = [
  { id: "documents", Icon: IconFileText },
  { id: "meetings", Icon: IconMicrophone },
  { id: "operations", Icon: IconServer },
  { id: "development", Icon: IconCode },
] as const;

function Mark({ className = "" }: { className?: string }) {
  return <svg viewBox="0 0 40 40" fill="none" className={className} aria-hidden="true">
    <path d="M20 3 25 15 37 20 25 25 20 37 15 25 3 20 15 15Z" fill="currentColor" />
    <path d="m8 8 12 5 12-5-5 12 5 12-12-5-12 5 5-12Z" fill="currentColor" opacity=".65" />
  </svg>;
}

function Brand() {
  return <span className={classes.brand}><Mark /><span>AXLEON<span className={classes.brandProduct}>AgentOps</span></span></span>;
}

function FeatureArt({ id }: { id: (typeof FEATURES)[number]["id"] }) {
  if (id === "configure") return <div className={classes.configureArt} aria-hidden="true">
    <span>MODEL</span><span>INSTRUCTIONS</span><span>SKILLS</span><span>MCP</span>
    <div className={classes.artConnector} /><div className={classes.miniAgent}><Mark /> AGENT</div>
  </div>;
  if (id === "execute") return <div className={classes.executeArt} aria-hidden="true">
    <span><IconFileText /> DOCX</span><span><IconMicrophone /> AUDIO</span><span><IconCode /> CODE</span>
    <i className={classes.executionLine} /><span className={classes.artCheck}><IconCheck /></span>
  </div>;
  if (id === "share") return <div className={classes.shareArt} aria-hidden="true">
    <div className={classes.avatarGroup}>{["YK", "JL", "SH", "MK"].map(name => <span key={name}>{name}</span>)}</div>
    <span className={classes.approvalPill}><IconShieldCheck size={16} /> HUMAN IN THE LOOP</span>
  </div>;
  return <div className={classes.observeArt} aria-hidden="true">
    {[20, 34, 25, 45, 32, 51, 43, 62, 52, 75, 61, 86, 71, 96, 80, 100, 88, 115].map((height, i) => <i key={i} style={{ height: `${height}px`, animationDelay: `${i * 35}ms` }} />)}
    <span className={classes.chartLine} />
  </div>;
}

function UseCases() {
  const t = useT();
  const [active, setActive] = useState(0);
  const selected = CASES[active]!;
  const tabsRef = useRef<HTMLDivElement>(null);

  return <div className={classes.caseExplorer}>
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

export function LandingPage() {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.setAttribute("data-revealed", "true");
        observer.unobserve(entry.target);
      }
    }, { threshold: 0.08 });
    root.querySelectorAll<HTMLElement>("[data-reveal]").forEach(element => {
      // Only upcoming sections are hidden; content remains readable without JS.
      if (!media.matches && element.getBoundingClientRect().top > window.innerHeight) {
        element.setAttribute("data-revealed", "false");
        observer.observe(element);
      }
    });
    return () => observer.disconnect();
  }, []);

  return <div className={classes.landing} ref={rootRef} id="top">
    <a className={classes.skipLink} href="#main-content" onClick={() => document.getElementById("main-content")?.focus()}>{t("chrome.skipToContent")}</a>
    <header className={classes.header} onKeyDown={event => {
      if (event.key === "Escape" && menuOpen) {
        setMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    }}>
      <div className={classes.headerInner}>
        <a href="#top" aria-label="AXLEON AgentOps" className={classes.brandLink}><Brand /></a>
        <nav aria-label={t("home.nav.platform")} className={classes.desktopNav}>{NAVIGATION.map(({ id, label }) => <a href={`#${id}`} key={id}>{t(label)}</a>)}</nav>
        <div className={classes.headerActions}>
          <LocaleToggle />
          <a className={classes.headerCta} href="/login">{t("home.start")}<IconArrowUpRight size={16} /></a>
          <button ref={menuButtonRef} className={classes.menuButton} type="button" aria-controls="landing-navigation" aria-expanded={menuOpen} aria-label={t(menuOpen ? "chrome.closeNavigation" : "chrome.openNavigation")} onClick={() => setMenuOpen(value => !value)}>{menuOpen ? <IconX size={22} /> : <IconMenu2 size={22} />}</button>
        </div>
      </div>
      <nav id="landing-navigation" className={classes.mobileNav} aria-label={t("chrome.openNavigation")} hidden={!menuOpen}>{NAVIGATION.map(({ id, label }, index) => <a href={`#${id}`} key={id} onClick={() => setMenuOpen(false)}><span>0{index + 1}</span>{t(label)}<IconArrowUpRight size={18} /></a>)}</nav>
    </header>

    <main id="main-content" tabIndex={-1}>
      <section className={`${classes.hero} ${classes.container}`} aria-labelledby="hero-title">
        <div className={classes.heroCopy}>
          <p className={classes.eyebrow}><span />{t("home.eyebrow")}</p>
          <h1 id="hero-title">{t("home.headline")}<span>{t("home.headlineAccent")}</span></h1>
          <p className={classes.lede}>{t("home.lede")}</p>
          <div className={classes.actions}>
            <a href="/login" className={classes.primaryButton}>{t("home.start")}<IconArrowUpRight size={20} /></a>
            <a href="/guide" className={classes.textButton}>{t("home.guide")}<IconArrowRight size={18} /></a>
          </div>
          <div className={classes.heroSignature}><span /><p>BUILT FOR YOUR PEOPLE.<br /><strong>CONNECTED TO YOUR WORK.</strong></p></div>
        </div>
        <ParticleField />
        <div className={classes.heroBottom}>
          <a href="#platform"><span className={classes.scrollIcon}><IconArrowDown size={16} /></span>{t("home.hero.scroll")}</a>
          <span>{t("home.hero.caption")}</span>
        </div>
      </section>

      <div className={classes.channelStrip}><div className={classes.container}>
        <p><span />{t("home.hero.tag")}</p>
        <div><span>Web Chat</span><span>Slack</span><span>Teams</span><span>Telegram</span><span>API</span><span>Webhook</span></div>
      </div></div>

      <section id="platform" className={`${classes.section} ${classes.container}`} aria-labelledby="platform-title" data-reveal>
        <div className={classes.sectionHeading}>
          <div><p className={classes.sectionLabel}>{t("home.platform.label")}</p><h2 id="platform-title">{t("home.platform.title")}</h2></div>
          <p>{t("home.platform.body")}</p>
        </div>
        <div className={classes.network}>
          <div className={classes.networkColumn}><p className={classes.microLabel}>{t("home.platform.channels")}</p>
            <div className={classes.networkNode}><IconMessageCircle /><div><h3>{t("home.platform.chat")}</h3><p>{t("home.platform.chatDetail")}</p></div></div>
            <div className={classes.networkNode}><IconUsers /><div><h3>{t("home.platform.messenger")}</h3><p>Slack · Teams · Telegram</p></div></div>
            <div className={classes.networkNode}><IconGitBranch /><div><h3>{t("home.platform.automation")}</h3><p>{t("home.platform.automationDetail")}</p></div></div>
          </div>
          <div className={classes.networkCenter}>
            <svg className={classes.networkLines} viewBox="0 0 360 320" preserveAspectRatio="none" aria-hidden="true"><path d="M0 55 C90 55 75 160 180 160 S270 55 360 55 M0 160 H360 M0 265 C90 265 75 160 180 160 S270 265 360 265" /></svg>
            <div className={classes.networkCore}><Mark /><strong>AXLEON<span>AgentOps</span></strong><span>{t("home.platform.core")}</span></div>
          </div>
          <div className={classes.networkColumn}><p className={classes.microLabel}>{t("home.platform.resources")}</p>
            <div className={classes.networkNode}><IconCpu /><div><h3>{t("home.platform.models")}</h3><p>{t("home.platform.modelsDetail")}</p></div></div>
            <div className={classes.networkNode}><IconPlugConnected /><div><h3>{t("home.platform.tools")}</h3><p>{t("home.platform.toolsDetail")}</p></div></div>
            <div className={classes.networkNode}><IconFileText /><div><h3>{t("home.platform.work")}</h3><p>{t("home.platform.workDetail")}</p></div></div>
          </div>
        </div>
        <div className={classes.governance}><p><IconShieldCheck size={18} />{t("home.platform.governance")}</p><div>{(["access", "approval", "history", "usage"] as const).map(key => <span key={key}>{t(`home.platform.${key}`)}</span>)}</div></div>
      </section>

      <section id="capabilities" className={classes.featuresSection} aria-labelledby="features-title">
        <div className={`${classes.section} ${classes.container}`}>
          <div className={classes.sectionHeading} data-reveal><div><p className={classes.sectionLabel}>{t("home.features.label")}</p><h2 id="features-title">{t("home.features.title")}</h2></div><p>{t("home.features.body")}</p></div>
          <div className={classes.featureGrid}>{FEATURES.map(({ id, Icon, tag }, index) => <article key={id} className={classes.featureCard} data-reveal>
            <div className={classes.featureTop}><span>0{index + 1} / {tag}</span><Icon size={21} stroke={1.5} /></div>
            <FeatureArt id={id} />
            <div className={classes.featureCopy}><p className={classes.featureCaption}>{t(`home.features.${id}.visual`)}</p><h3>{t(`home.features.${id}.title`)}</h3><p>{t(`home.features.${id}.body`)}</p></div>
          </article>)}</div>
        </div>
      </section>

      <section id="use-cases" className={`${classes.section} ${classes.container}`} aria-labelledby="cases-title" data-reveal>
        <div className={classes.sectionHeading}><div><p className={classes.sectionLabel}>{t("home.cases.label")}</p><h2 id="cases-title">{t("home.cases.title")}</h2></div><p>{t("home.cases.body")}</p></div>
        <UseCases />
      </section>

      <section id="deployment" className={`${classes.deployment} ${classes.container}`} aria-labelledby="install-title" data-reveal>
        <div className={classes.installCopy}><p className={classes.sectionLabel}>{t("home.install.label")}</p><h2 id="install-title">{t("home.install.title")}</h2><p>{t("home.install.body")}</p><a href="/guide#install" className={classes.textButton}>{t("home.guide")}<IconArrowUpRight size={18} /></a></div>
        <div className={classes.installDiagram}><div className={classes.boundaryLabel}><IconLock size={14} />{t("home.install.boundary")}</div><div className={classes.installCore}><Mark /><span>AXLEON AgentOps</span></div><div className={classes.installNodes}>{[{ key: "network", Icon: IconServer }, { key: "auth", Icon: IconShieldCheck }, { key: "models", Icon: IconCpu }].map(({ key, Icon }) => <div key={key}><Icon size={23} stroke={1.5} /><span>{t(`home.install.${key}` as "home.install.network" | "home.install.auth" | "home.install.models")}</span></div>)}</div><p><i />{t("home.install.private")}</p></div>
      </section>

      <section className={classes.closing} aria-labelledby="cta-title" data-reveal><div className={classes.closingOrbit} aria-hidden="true" /><div className={classes.container}><p className={classes.sectionLabel}>THE NEXT WAY TO WORK</p><h2 id="cta-title">{t("home.cta.title")}</h2><p>{t("home.cta.body")}</p><div className={classes.actions}><a href="/login" className={classes.primaryButton}>{t("home.start")}<IconArrowUpRight size={20} /></a><a href="/guide" className={classes.textButton}>{t("home.guide")}<IconArrowRight size={18} /></a></div></div><IconSparkles className={classes.closingSpark} size={42} stroke={1} aria-hidden="true" /></section>
    </main>
    <footer className={`${classes.footer} ${classes.container}`}><div className={classes.footerTop}><a href="#top" aria-label="AXLEON AgentOps"><Brand /></a><p>{t("home.footer.description")}</p><a href="#top" className={classes.backToTop}>{t("home.footer.top")}<IconChevronUp size={18} /></a></div><div className={classes.footerBottom}><span>© CLUSH. All rights reserved.</span><span>DESIGNED FOR COLLECTIVE INTELLIGENCE.</span><a href="/guide">{t("home.guide")}<IconArrowUpRight size={14} /></a></div></footer>
  </div>;
}
