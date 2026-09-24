"use client";

/**
 * The one modal a picture opens in — from the artifacts gallery, a chat
 * message or a project's run panel.
 *
 * **The frame is the screen.** The dialog is full-screen over a dark ground and
 * everything that is not the picture floats on top of it: no header row, no
 * caption column. A 90vw × 90dvh frame with a title bar above the image and the
 * prompt below it spent a fixed share of every screen on two lines of text, and
 * the picture — the only reason the dialog opens — got what was left.
 *
 * What floats: the controls at the top right, and the details panel along the
 * bottom, which is a *toggle*. Folded away it takes nothing, so a paragraph-long
 * prompt costs the picture no height until somebody asks to read it. The toggle
 * is kept for the life of the provider rather than reset per picture: a reader
 * who wants the prompt wants it for the next one too.
 *
 * The picture itself behaves as it always has: it opens scaled down to fit, a
 * click draws it at its own pixel size — scrolling in both directions when it is
 * bigger than the screen — and another click fits it again. The frame never
 * changes shape across that toggle.
 *
 * "Actual" really is the image's own size: `<Image w="auto">` inside a `Stack`
 * is stretched to the container by `align-items: stretch`, which is how an
 * earlier "original" mode ended up blowing a 1024px picture up to the width of
 * the monitor. The frame is a flex row and the picture a `flex-shrink: 0` item
 * with `margin: auto` — centred while it fits, and with its top-left corner
 * still reachable once it scrolls, which `align-items: center` would have
 * clipped.
 *
 * "Fit" never scales *up*: `max-width`/`max-height` cap a small picture at its
 * natural size rather than smearing it across the screen.
 *
 * A click on the ground closes; a click on the picture zooms; a click on a
 * control does what the control says and nothing else — hence the
 * `stopPropagation` on each, and the `target === currentTarget` check on the
 * ground, which is what keeps a click that lands on a child from closing.
 *
 * One provider for the app, at the root: a chat thread renders as many images
 * as it has turns, and each mounting its own portal to show at most one of
 * them is what this replaces.
 */

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { ActionIcon, Box, CopyButton, Group, Image, Modal, Stack, Text } from "@mantine/core";
import { IconCheck, IconCopy, IconInfoCircle, IconX, IconZoomIn, IconZoomOut } from "@tabler/icons-react";
import { useT } from "@/app/_i18n/provider";

export type ViewedImage = {
  src: string;
  alt: string;
  /** Names the picture in the details panel — a filename when there is one; the `alt` otherwise. */
  title?: string;
  /** Read in the details panel — the prompt that drew it, and what the copy button copies. */
  caption?: string;
};

export type ViewImage = (image: ViewedImage) => void;

const ImageViewerContext = createContext<ViewImage | null>(null);

/** Opens the shared viewer. Throws outside `ImageViewerProvider`, which the root layout mounts. */
export function useImageViewer(): ViewImage {
  const view = useContext(ImageViewerContext);
  if (!view) {
    throw new Error("useImageViewer must be used within ImageViewerProvider");
  }
  return view;
}

export function ImageViewerProvider({ children }: { children: React.ReactNode }) {
  const t = useT();
  // `opened` is separate from `image` so the picture stays drawn while the
  // dialog animates out; clearing it on close showed an empty frame fading.
  const [image, setImage] = useState<ViewedImage | null>(null);
  const [opened, setOpened] = useState(false);
  const [actual, setActual] = useState(false);
  // Deliberately not reset per picture — see the note at the top.
  const [showInfo, setShowInfo] = useState(false);
  // The picture's own pixel size, which only the bytes know. Reset with
  // `actual`, or the panel reports the previous picture's dimensions for as
  // long as this one takes to load.
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const pathname = usePathname();

  const view = useCallback<ViewImage>((next) => {
    setImage(next);
    setActual(false);
    setSize(null);
    setOpened(true);
  }, []);

  // The provider outlives every page, so a viewer left open would follow the
  // reader onto the next one.
  useEffect(() => {
    setOpened(false);
  }, [pathname]);

  // Its own handler rather than an arrow in the JSX: React nulls
  // `currentTarget` once a handler returns, and a state updater sitting a few
  // lines above it is the shape `tests/architecture.test.ts` refuses — the
  // event has to be read in the scope it was dispatched to.
  function recordSize(event: React.SyntheticEvent<HTMLImageElement>) {
    const { naturalWidth, naturalHeight } = event.currentTarget;
    setSize({ width: naturalWidth, height: naturalHeight });
  }

  return (
    <ImageViewerContext.Provider value={view}>
      {children}
      <Modal
        opened={opened}
        onClose={() => setOpened(false)}
        fullScreen
        withCloseButton={false}
        padding={0}
        transitionProps={{ transition: "fade" }}
        // The dark ground is one layer, on the content: a full-screen dialog's
        // content covers the viewport, so Mantine's overlay sits behind it and
        // its opacity never reaches the eye.
        styles={{
          content: { background: "rgba(0, 0, 0, 0.85)" },
          body: { height: "100%", padding: 0, position: "relative" },
        }}
      >
        {image && (
          <>
            <Box
              onClick={(event) => {
                if (event.target === event.currentTarget) {
                  setOpened(false);
                }
              }}
              style={{
                height: "100%",
                display: "flex",
                overflow: actual ? "auto" : "hidden",
              }}
            >
              <Image
                src={image.src}
                alt={image.alt}
                w="auto"
                h="auto"
                maw={actual ? "none" : "100%"}
                mah={actual ? "none" : "100%"}
                onClick={() => setActual((current) => !current)}
                onLoad={recordSize}
                style={{ margin: "auto", flexShrink: 0, cursor: actual ? "zoom-out" : "zoom-in" }}
              />
            </Box>

            <Group
              gap="xs"
              style={{
                position: "absolute",
                top: "var(--mantine-spacing-md)",
                right: "var(--mantine-spacing-md)",
                zIndex: 2,
              }}
            >
              <ActionIcon
                variant="default"
                size="lg"
                aria-label={t(actual ? "viewer.fit" : "viewer.actual")}
                title={t(actual ? "viewer.fit" : "viewer.actual")}
                onClick={(event) => {
                  event.stopPropagation();
                  setActual((current) => !current);
                }}
              >
                {actual ? <IconZoomOut size={18} /> : <IconZoomIn size={18} />}
              </ActionIcon>
              <ActionIcon
                variant={showInfo ? "filled" : "default"}
                size="lg"
                aria-pressed={showInfo}
                aria-label={t(showInfo ? "viewer.hideInfo" : "viewer.showInfo")}
                title={t(showInfo ? "viewer.hideInfo" : "viewer.showInfo")}
                onClick={(event) => {
                  event.stopPropagation();
                  setShowInfo((current) => !current);
                }}
              >
                <IconInfoCircle size={18} />
              </ActionIcon>
              {/* Mantine's render prop directly rather than the app's
                  `CopyButton` wrapper: that one is a labelled `Button`, and
                  what varies here is the whole control, not its label. */}
              {image.caption && (
                <CopyButton value={image.caption} timeout={1500}>
                  {({ copied, copy }) => (
                    <ActionIcon
                      variant="default"
                      size="lg"
                      aria-label={t(copied ? "common.copied" : "viewer.copyPrompt")}
                      title={t(copied ? "common.copied" : "viewer.copyPrompt")}
                      onClick={(event) => {
                        event.stopPropagation();
                        copy();
                      }}
                    >
                      {copied ? <IconCheck size={18} /> : <IconCopy size={18} />}
                    </ActionIcon>
                  )}
                </CopyButton>
              )}
              <ActionIcon
                variant="default"
                size="lg"
                aria-label={t("viewer.close")}
                title={t("viewer.close")}
                onClick={(event) => {
                  event.stopPropagation();
                  setOpened(false);
                }}
              >
                <IconX size={18} />
              </ActionIcon>
            </Group>

            {showInfo && (
              <Box
                onClick={(event) => event.stopPropagation()}
                style={{
                  position: "absolute",
                  insetInline: 0,
                  bottom: 0,
                  zIndex: 2,
                  maxHeight: "40%",
                  overflowY: "auto",
                  background: "rgba(0, 0, 0, 0.78)",
                  padding: "var(--mantine-spacing-md)",
                }}
              >
                {/* Fixed light colours, not theme tokens: this sits on the
                    dark ground in either colour scheme, and the light theme's
                    body text would be invisible on it. */}
                <Stack gap={4}>
                  <Text fz="sm" fw={500} c="white">
                    {image.title ?? image.alt}
                  </Text>
                  {image.caption && (
                    <Text fz="sm" c="gray.3" style={{ whiteSpace: "pre-wrap" }}>
                      {image.caption}
                    </Text>
                  )}
                  {size && (
                    <Text fz="xs" c="gray.4">
                      {size.width} × {size.height}
                    </Text>
                  )}
                </Stack>
              </Box>
            )}
          </>
        )}
      </Modal>
    </ImageViewerContext.Provider>
  );
}
