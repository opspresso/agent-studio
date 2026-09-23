"use client";

import { useEffect, useRef } from "react";
import { useStickToBottom } from "use-stick-to-bottom";

/** Land after asynchronous history is ready, then let the viewport follow only while the reader stays at the bottom. */
export function useLatestScroll(ready: boolean, viewKey: string) {
  const scroll = useStickToBottom({ resize: "instant", initial: "instant" });
  const landed = useRef<string | null>(null);

  useEffect(() => {
    if (!ready || landed.current === viewKey) return;
    landed.current = viewKey;
    void scroll.scrollToBottom({ animation: "instant" });
  }, [ready, viewKey, scroll.scrollToBottom]);

  return scroll;
}
