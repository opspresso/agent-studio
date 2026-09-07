/**
 * A document AST to PPTX.
 *
 * The fourth renderer, and the first whose output is not a page of prose — so it
 * is a package rather than a file. The pipeline is the spec of the split:
 *
 *     MarkdownDocument → planner.ts → Presentation → render.ts → slide XML
 *                                                    package.ts → everything else
 *
 * `planner.ts` decides what each slide *is* (its archetype, and where one ends),
 * `render.ts` decides what shapes say that, `package.ts` carries the scaffolding
 * PowerPoint refuses to open a file without, and `layout.ts` is the geometry
 * both sides measure against. This module only assembles the zip.
 */

import { buildZip } from "../../zip";
import type { MarkdownDocument } from "../../markdown";
import { part } from "./ooxml";
import {
  LAYOUT_COUNT,
  appPropertiesXml,
  contentTypesXml,
  corePropertiesXml,
  packageRelsXml,
  presPropsXml,
  presentationRelsXml,
  presentationXml,
  slideLayoutRelsXml,
  slideLayoutXml,
  slideMasterRelsXml,
  slideMasterXml,
  slideRelsXml,
  tableStylesXml,
  themeXml,
  viewPropsXml,
  type LayoutIndex,
} from "./package";
import { DocumentError } from "../../errors";
import { extensionOf, imageSize, type ImageAsset } from "../image";
import { plan } from "./planner";
import { Renderer, type MediaEntry } from "./render";
import type { Slide } from "./types";
import { designFor, type DocumentProfile } from "../theme";

/**
 * Which layout part carries each archetype's design.
 *
 * The recognised archetypes — cards, metrics, quote, comparison — share the
 * content layout: same ground, same footer, same title chrome. Their geometry
 * is per-slide shape work, not layout furniture.
 */
const LAYOUT_OF: Record<Slide["type"], LayoutIndex> = {
  cover: 1,
  content: 2,
  cards: 2,
  metrics: 2,
  quote: 2,
  comparison: 2,
  process: 2,
  timeline: 2,
  image: 2,
  section: 3,
  closing: 4,
};

export interface PptxOptions {
  title: string;
  /** ISO 8601, passed in so the bytes are a function of the input alone. */
  created: string;
  profile?: DocumentProfile;
  /** Keyed by the name `asset://name` references. */
  assets?: Record<string, ImageAsset>;
}

export interface RenderedPptx {
  bytes: Uint8Array;
  /** How many slides the Markdown turned into, which is what the caller reports. */
  slides: number;
  /** Slides created because one section did not fit in its first box. */
  continuations: number;
}

export function renderPptx(document: MarkdownDocument, options: PptxOptions): RenderedPptx {
  const design = designFor(options.profile);
  const { slides } = plan(document, design);

  /**
   * One media part per referenced asset, numbered in first-use order. A
   * reference with no bytes behind it is refused by name here, before any
   * slide renders: a deck with a silently absent picture reads as "the image
   * was empty", which is the wrong claim.
   */
  const media = new Map<string, MediaEntry>();
  const assets = options.assets ?? {};
  for (const slide of slides) {
    if (slide.type !== "image" || media.has(slide.asset)) {
      continue;
    }
    const asset = Object.hasOwn(assets, slide.asset) ? assets[slide.asset] : undefined;
    if (!asset) {
      throw new DocumentError(
        `the document references asset://${slide.asset} but no asset of that name was provided`,
      );
    }
    media.set(slide.asset, {
      file: `image${media.size + 1}.${extensionOf(asset.mimeType)}`,
      size: imageSize(asset.bytes, asset.mimeType),
    });
  }
  const extensions = [...new Set([...media.keys()].map((name) => extensionOf(assets[name]!.mimeType)))];

  const renderer = new Renderer(media, design);
  const parts: Record<string, Uint8Array> = {
    "[Content_Types].xml": part(contentTypesXml(slides.length, extensions)),
    "_rels/.rels": part(packageRelsXml()),
    "docProps/core.xml": part(corePropertiesXml(options.title, options.created)),
    "docProps/app.xml": part(appPropertiesXml()),
    "ppt/presentation.xml": part(presentationXml(slides.length)),
    "ppt/_rels/presentation.xml.rels": part(presentationRelsXml(slides.length)),
    "ppt/theme/theme1.xml": part(themeXml(design)),
    "ppt/presProps.xml": part(presPropsXml()),
    "ppt/viewProps.xml": part(viewPropsXml()),
    "ppt/tableStyles.xml": part(tableStylesXml()),
    "ppt/slideMasters/slideMaster1.xml": part(slideMasterXml(design)),
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": part(slideMasterRelsXml()),
  };

  for (let layout = 1; layout <= LAYOUT_COUNT; layout += 1) {
    parts[`ppt/slideLayouts/slideLayout${layout}.xml`] = part(
      slideLayoutXml(layout as LayoutIndex, options.title, design),
    );
    parts[`ppt/slideLayouts/_rels/slideLayout${layout}.xml.rels`] = part(slideLayoutRelsXml());
  }

  for (const [name, entry] of media) {
    parts[`ppt/media/${entry.file}`] = assets[name]!.bytes;
  }

  slides.forEach((slide, index) => {
    const rendered = renderer.slide(slide, index);
    parts[`ppt/slides/slide${index + 1}.xml`] = part(rendered.xml);
    parts[`ppt/slides/_rels/slide${index + 1}.xml.rels`] = part(
      slideRelsXml(LAYOUT_OF[slide.type], rendered.rels),
    );
  });

  return {
    bytes: buildZip(parts),
    slides: slides.length,
    continuations: slides.filter((slide) => slide.type === "content" && slide.continuation).length,
  };
}
