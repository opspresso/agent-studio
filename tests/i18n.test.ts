/**
 * The language a request is served in, and the string a key turns into.
 *
 * Three things here are worth a test rather than a reading of the code. The
 * header parse ranks by `q` instead of trusting the order it arrived in, which
 * only a header written by a proxy ever exercises. The catalogues are kept in
 * step by the compiler — `ko.ts` is typed as `Messages` — but the compiler
 * cannot see an *empty* Korean string, which renders as a blank spot on a page
 * and reads as a layout bug rather than a missing translation. And an unfilled
 * placeholder is left visible on purpose; the tempting fix is to drop it, which
 * turns a reported bug into a sentence that looks finished and is wrong.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_LABELS,
  isLocale,
  negotiateLocale,
} from "@/app/_i18n/locale";
import { translator } from "@/app/_i18n/translate";
import { en } from "@/app/_i18n/messages/en";
import { ko } from "@/app/_i18n/messages/ko";

describe("negotiateLocale", () => {
  it("matches on the primary subtag, so a region tag still counts", () => {
    expect(negotiateLocale("ko-KR,ko;q=0.9")).toBe("ko");
  });

  it("reads quality values rather than trusting arrival order", () => {
    // What a rewriting proxy can produce: Korean last, and preferred.
    expect(negotiateLocale("en;q=0.3, ko;q=0.9")).toBe("ko");
  });

  it("skips a language it does not speak", () => {
    expect(negotiateLocale("fr-FR,fr;q=0.9,ko;q=0.5")).toBe("ko");
  });

  it("falls back when nothing matches", () => {
    expect(negotiateLocale("fr-FR,de;q=0.8")).toBe(DEFAULT_LOCALE);
  });

  it.each([undefined, null, "", "   "])("falls back on %o", (header) => {
    expect(negotiateLocale(header)).toBe(DEFAULT_LOCALE);
  });

  it("ignores an entry the client explicitly refused", () => {
    // `q=0` means "not acceptable" — honouring it as a preference would serve
    // Korean to a reader who asked not to have it.
    expect(negotiateLocale("ko;q=0, en;q=0.5")).toBe("en");
  });

  it("treats a missing q as the highest preference", () => {
    expect(negotiateLocale("ko, en;q=0.9")).toBe("ko");
  });

  it("is case-insensitive, as a language tag is by definition", () => {
    expect(negotiateLocale("KO-kr")).toBe("ko");
  });
});

describe("isLocale", () => {
  it.each([...LOCALES])("accepts %s", (value) => {
    expect(isLocale(value)).toBe(true);
  });

  it.each(["", "fr", "en-US", undefined, null])("rejects %o", (value) => {
    expect(isLocale(value)).toBe(false);
  });
});

describe("the catalogues", () => {
  it("carry a non-empty string for every key, in both languages", () => {
    // The types already force every key to exist. What they cannot see is `""`,
    // which type-checks and renders as nothing at all.
    const blank = Object.keys(en).filter(
      (key) =>
        en[key as keyof typeof en].trim() === "" ||
        ko[key as keyof typeof ko].trim() === "",
    );
    expect(blank).toEqual([]);
  });

  it("name each language in itself", () => {
    // A picker that says "Korean" to someone who cannot read English is the one
    // control that has to be legible before the choice is made.
    expect(LOCALE_LABELS.ko).toBe("한국어");
    expect(LOCALE_LABELS.en).toBe("English");
  });
});

describe("translator", () => {
  it.each(["en", "ko"] as const)("uses plural collection names and singular item names in %s", locale => {
    const t = translator(locale);
    expect(t("nav.chats")).toBe("Chats");
    expect(t("chat.list")).toBe("Chats");
    expect(t("chat.kind")).toBe("Chat");
    expect(t("workspace.list")).toBe("Workspaces");
    expect(t("workspace.kind")).toBe("Workspace");
    expect(t("chat.history")).toBe("Chats & Workspaces");
    for (const [key, label] of [
      ["nav.agents", "Agents"], ["nav.artifacts", "Artifacts"], ["nav.plugins", "Plugins"],
      ["nav.skills", "Skills"], ["nav.tools", "Tools"], ["nav.models", "Models"],
      ["nav.members", "Members"],
    ] as const) expect(t(key)).toBe(label);
    for (const [key, noun] of [
      ["agents.new", "Agent"], ["skills.new", "Skill"],
      ["artifacts.deleteTitle", "Artifact"], ["modelAdmin.add", "Model"],
      ["members.member", "Member"],
    ] as const) expect(t(key)).toContain(noun);
  });

  it("uses the deployment name in branded copy", () => {
    expect(translator("en", "AgentOps")("home.coverage")).toBe("What AgentOps covers");
    expect(translator("ko", "AgentOps")("login.product")).toBe("AgentOps에서 AI 에이전트를 만들고 활용하세요.");
  });

  it("answers from the catalogue of the locale it was built for", () => {
    expect(translator("en")("locale.label")).toBe(en["locale.label"]);
    expect(translator("ko")("locale.label")).toBe(ko["locale.label"]);
  });

  it("fills a placeholder in both languages", () => {
    expect(translator("en")("chrome.status", { version: "0.58.3" })).toBe(
      "Version 0.58.3",
    );
    expect(translator("ko")("chrome.status", { version: "0.58.3" })).toBe(
      "버전 0.58.3",
    );
  });

  it("accepts a number as a value", () => {
    expect(translator("en")("chrome.status", { version: 1 })).toBe("Version 1");
  });

  it("leaves a placeholder it was given no value for", () => {
    // Reaching a page as `{version}` is a bug report; reaching it as `v` is a
    // sentence that looks finished and is wrong.
    expect(translator("en")("chrome.status", { unrelated: 1 })).toBe(
      "Version {version}",
    );
    expect(translator("en")("chrome.status")).toBe("Version {version}");
  });

  it("fills every placeholder in a message that has more than one", () => {
    // `theme.current` nests a translated value inside another message, which is
    // what the toggle's aria-label does.
    const t = translator("ko");
    expect(t("theme.current", { name: t("theme.dark") })).toBe("테마: 다크");
  });
});
