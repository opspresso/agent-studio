"use client";

/**
 * The one modal a picture opens in — from the artifacts gallery, a chat
 * message, a project's run panel or its compare view.
 *
 * The dialog is a fixed frame that fits the screen (90vw × 90dvh, centred),
 * and only the picture inside it changes: it opens scaled down to fit the
 * frame, a click draws it at its own pixel size — scrolling inside the frame
 * in both directions when it is bigger — and another click fits it again. The
 * frame never changes shape or size across that toggle, and there is no
 * full-screen takeover: a viewer that resized or replaced its own dialog per
 * mode was two things to look at, and this is one.
 *
 * "Actual" really is the image's own size: `<Image w="auto">` inside a
 * `Stack` is stretched to the container by `align-items: stretch`, which is
 * how an earlier "original" mode ended up blowing a 1024px picture up to the
 * width of the monitor. The frame is a flex row and the picture a
 * `flex-shrink: 0` item with `margin: auto` — centred while it fits, and with
 * its top-left corner still reachable once it scrolls, which
 * `align-items: center` would have clipped.
 *
 * "Fit" never scales *up*: `max-width`/`max-height` cap a small picture at
 * its natural size rather than smearing it across the frame.
 *
 * One provider for the app, at the root: a chat thread renders as many images
 * as it has turns, and each mounting its own portal to show at most one of
 * them is what this replaces.
 */

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Box, Image, Modal, ScrollArea, Stack, Text } from "@mantine/core";

export type ViewedImage = {
  src: string;
  alt: string;
  /** The dialog's header — a filename when there is one; the `alt` otherwise. */
  title?: string;
  /** Read under the picture — the prompt that drew it. */
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
  // `opened` is separate from `image` so the picture stays drawn while the
  // dialog animates out; clearing it on close showed an empty frame fading.
  const [image, setImage] = useState<ViewedImage | null>(null);
  const [opened, setOpened] = useState(false);
  const [actual, setActual] = useState(false);
  const pathname = usePathname();

  const view = useCallback<ViewImage>((next) => {
    setImage(next);
    setActual(false);
    setOpened(true);
  }, []);

  // The provider outlives every page, so a viewer left open would follow the
  // reader onto the next one.
  useEffect(() => {
    setOpened(false);
  }, [pathname]);

  return (
    <ImageViewerContext.Provider value={view}>
      {children}
      <Modal
        opened={opened}
        onClose={() => setOpened(false)}
        title={
          <Text fw={500} lineClamp={1}>
            {image?.title ?? image?.alt}
          </Text>
        }
        size="90vw"
        centered
        // A frame of fixed shape: the dialog is a flex column of header, picture
        // and caption, and the picture's box takes whatever height the other two
        // leave — which is what lets it be the scroll container at actual size
        // while the caption stays put underneath.
        styles={{
          content: { height: "90dvh", display: "flex", flexDirection: "column" },
          body: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" },
        }}
      >
        {image && (
          <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
            <Box
              style={{
                flex: 1,
                minHeight: 0,
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
                style={{ margin: "auto", flexShrink: 0, cursor: actual ? "zoom-out" : "zoom-in" }}
              />
            </Box>
            {image.caption && (
              // Its own scroll region rather than the frame's: a long prompt
              // scrolls where it is instead of moving the picture off screen.
              <ScrollArea.Autosize mah="18vh" type="auto">
                <Text fz="sm" c="dimmed" style={{ whiteSpace: "pre-wrap" }}>
                  {image.caption}
                </Text>
              </ScrollArea.Autosize>
            )}
          </Stack>
        )}
      </Modal>
    </ImageViewerContext.Provider>
  );
}
