"use client";

import { useEffect, useState } from "react";

type Theme = "system" | "light" | "dark";

const THEMES: Theme[] = ["system", "light", "dark"];

const LABELS: Record<Theme, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

function applyTheme(theme: Theme) {
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.dataset.theme = theme;
}

function ThemeIcon({ theme }: { theme: Theme }) {
  if (theme === "light") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="12" r="3.5" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42" />
      </svg>
    );
  }
  if (theme === "dark") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M20.2 15.4A8.5 8.5 0 0 1 8.6 3.8 8.5 8.5 0 1 0 20.2 15.4Z" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("agent-studio-theme");
    const initial = THEMES.includes(stored as Theme) ? (stored as Theme) : "system";
    setTheme(initial);
    applyTheme(initial);

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      if ((localStorage.getItem("agent-studio-theme") ?? "system") === "system") {
        applyTheme("system");
      }
    };
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  function changeTheme(next: Theme) {
    localStorage.setItem("agent-studio-theme", next);
    setTheme(next);
    applyTheme(next);
    setOpen(false);
  }

  return (
    <div
      className="relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-label={`Theme: ${LABELS[theme]}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={LABELS[theme]}
        className="inline-flex size-9 items-center justify-center rounded-lg border border-neutral-200 bg-white/80 text-neutral-600 shadow-sm transition hover:border-neutral-300 hover:bg-neutral-100 hover:text-neutral-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand dark:border-neutral-800 dark:bg-neutral-900/80 dark:text-neutral-300 dark:hover:border-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-white"
      >
        <ThemeIcon theme={theme} />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Theme"
          className="absolute right-0 top-full z-20 mt-1 flex gap-1 rounded-lg border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-800 dark:bg-neutral-900"
        >
          {THEMES.map((option) => (
            <button
              key={option}
              type="button"
              role="menuitemradio"
              aria-checked={theme === option}
              aria-label={LABELS[option]}
              title={LABELS[option]}
              onClick={() => changeTheme(option)}
              className={`inline-flex size-8 items-center justify-center rounded-md transition hover:bg-neutral-100 dark:hover:bg-neutral-800 ${
                theme === option
                  ? "bg-neutral-100 text-neutral-950 dark:bg-neutral-800 dark:text-white"
                  : "text-neutral-500 dark:text-neutral-400"
              }`}
            >
              <ThemeIcon theme={option} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
