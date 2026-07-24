"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Textarea with a toggle that fits its height to the content and reverts to the
 * default (rows) height. Starts at the default height; the button switches between
 * "Fit to content" and "Default height".
 */
export function ResizableTextarea({
  value,
  onChange,
  rows,
  placeholder,
  className = "",
  footerLeft,
  footerRight,
}: {
  value: string;
  onChange: (value: string) => void;
  rows: number;
  placeholder?: string;
  className?: string;
  footerLeft?: React.ReactNode;
  footerRight?: React.ReactNode;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [fit, setFit] = useState(false);

  useEffect(() => {
    if (!fit) {
      return;
    }
    const el = ref.current;
    if (!el) {
      return;
    }
    // Measure at height 0 so short content shrinks and long content grows to an exact fit.
    el.style.height = "0px";
    const cs = getComputedStyle(el);
    const border =
      (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    el.style.height = `${el.scrollHeight + border}px`;
  }, [fit, value]);

  function toggle() {
    const next = !fit;
    if (!next && ref.current) {
      ref.current.style.height = "";
    }
    setFit(next);
  }

  return (
    <>
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        className={`${className} ${fit ? "resize-none overflow-hidden" : ""}`}
      />
      <div className="mt-1 flex items-center justify-between gap-2">
        {footerLeft ?? <span />}
        <div className="flex items-center gap-2">
          {footerRight}
          <button
            type="button"
            onClick={toggle}
            title={fit ? "Default height" : "Fit to content"}
            aria-label={fit ? "Default height" : "Fit to content"}
            className="shrink-0 rounded bg-neutral-100 p-1 text-neutral-500 hover:bg-neutral-200 hover:text-neutral-700 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
          >
            <svg
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className="h-4 w-4"
            >
              {fit ? (
                <>
                  <path d="M7 4l3 3 3-3" />
                  <path d="M7 16l3-3 3 3" />
                </>
              ) : (
                <>
                  <path d="M7 7l3-3 3 3" />
                  <path d="M7 13l3 3 3-3" />
                </>
              )}
            </svg>
          </button>
        </div>
      </div>
    </>
  );
}
