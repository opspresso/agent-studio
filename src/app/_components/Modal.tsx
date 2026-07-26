"use client";

/**
 * Centred dialog over a dimmed backdrop. Closes on Escape and on a backdrop
 * click, never on a click inside — a form that vanished because the pointer
 * drifted over the edge would lose whatever was typed.
 */

import { useEffect, useRef } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  // Held in a ref so the listener below binds once. Every call site passes an
  // inline arrow, so keying the effect on `onClose` would tear the listener down
  // and rebuild it — and rewrite document.body.style — on every keystroke typed
  // into the form this dialog contains.
  const close = useRef(onClose);
  close.current = onClose;

  // The page behind must not scroll under the dialog.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // `aria-modal` tells assistive tech the rest of the page is unavailable, so
  // focus has to behave that way: it starts on the dialog, which announces its
  // name; Tab cannot walk out into the form behind the backdrop, where clicks
  // are swallowed but every control was still reachable by keyboard; and closing
  // hands focus back to whatever opened the dialog.
  useEffect(() => {
    const opener = document.activeElement;
    panel.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        close.current();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const items = [...(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panel.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (opener instanceof HTMLElement) {
        opener.focus();
      }
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8"
      onMouseDown={(event) => {
        if (!panel.current?.contains(event.target as Node)) {
          onClose();
        }
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="w-full max-w-2xl rounded-lg border border-neutral-200 bg-white shadow-xl outline-none dark:border-neutral-800 dark:bg-neutral-900"
      >
        <div className="flex items-center justify-between gap-4 border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            ✕
          </button>
        </div>
        <div className="space-y-5 p-4">{children}</div>
      </div>
    </div>
  );
}
