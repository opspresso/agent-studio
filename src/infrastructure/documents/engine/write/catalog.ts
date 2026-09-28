import { DOCUMENT_COLOR_NAMES, DOCUMENT_PROFILES, DOCUMENT_THEMES, DEFAULT_DOCUMENT_PROFILE, DEFAULT_DOCUMENT_THEME, documentLayoutFor } from "@/domain/document/processor";
import { DOC, DECK, WEB, LEADING, DOCUMENT_FONT, PAGE_GEOMETRY, PAPER_COLOR, THEMES, designFor } from "./theme";

/** A serializable projection of the actual renderer contract for skill bundles and native editors. */
export function documentDesignCatalog() {
  return {
    version: 1,
    defaults: { profile: DEFAULT_DOCUMENT_PROFILE, theme: DEFAULT_DOCUMENT_THEME, pageLayout: documentLayoutFor("docx"), deckLayout: documentLayoutFor("pptx") },
    colors: DOCUMENT_COLOR_NAMES,
    fonts: { body: DOCUMENT_FONT, googleBody: "Nanum Gothic", webBody: `"${DOCUMENT_FONT}", "Nanum Gothic", system-ui, -apple-system, "Segoe UI", sans-serif`,
      code: { docx: "Consolas", pptx: "Consolas", hwpx: "굴림체", pdf: "Courier", web: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
      editableFontRequirement: "NanumGothic must be installed on the reader's device; PDF embeds the font." },
    page: { unit: "pt", ...PAGE_GEOMETRY, background: PAPER_COLOR },
    type: { page: { unit: "pt", ...DOC }, deck: { unit: "pt", ...DECK }, web: { unit: "px", ...WEB } },
    leading: LEADING,
    chart: designFor().chart,
    themes: Object.fromEntries(DOCUMENT_THEMES.map(theme => [theme, THEMES[theme]])),
    profiles: Object.fromEntries(DOCUMENT_PROFILES.map(profile => {
      const design = designFor(profile);
      return [profile, { label: design.label, purpose: design.description,
        tableHeader: design.table.headerFill === design.palette.brandTint ? "light" : "solid",
        doc: design.doc, deck: { coverBandPoints: design.deck.coverBandPoints, cornerRadiusFraction: design.deck.cardRadius / 100000 } }];
    })),
  };
}
