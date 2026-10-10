"use client";

/**
 * Shared full-screen image viewer for the gallery, Chat and Playground.
 * Fit caps the image at its natural size; Actual preserves its pixels and
 * allows two-axis scrolling. Flex auto margins keep an oversized image's
 * top-left corner reachable while centering images that fit.
 *
 * The ground closes, the image toggles zoom, and controls act independently.
 * Overlay controls and a collapsible details panel leave the image its full
 * viewport. The root provider retains the details preference across images.
 */

import { createContext, useCallback, useContext, useEffect, useId, useState } from "react";
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
  const detailsId = useId();
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
        attributes={{ content: { "aria-label": t("viewer.title") } }}
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
                aria-expanded={showInfo}
                aria-controls={showInfo ? detailsId : undefined}
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
                id={detailsId}
                tabIndex={0}
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
