"use client";

import { useEffect, useRef, useState } from "react";
import { buttonClass } from "@/app/_components/buttonStyles";

/** Shared clipboard button with transient "Copied" feedback. */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    };
  }, []);

  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    if (timer.current) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button
      type="button"
      onClick={copy}
      className={`shrink-0 ${buttonClass("secondary", "xs")}`}
    >
      {copied ? "Copied" : label}
    </button>
  );
}
