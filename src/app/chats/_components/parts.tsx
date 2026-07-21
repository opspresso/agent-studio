"use client";

import { useState } from "react";
import type { ChatMessage, LiveTurn } from "../_lib/types";

export function ToolResultBlock({ content, label }: { content: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1 overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-800">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center gap-2 bg-neutral-100 px-3 py-1.5 text-left text-xs font-medium text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
      >
        <span className="text-neutral-400">{open ? "▾" : "▸"}</span>
        <span>{label ?? "Tool result"}</span>
      </button>
      {open && (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words bg-neutral-50 px-3 py-2 font-mono text-xs text-neutral-700 dark:bg-neutral-950 dark:text-neutral-300">
          {content}
        </pre>
      )}
    </div>
  );
}

export function AuthorBadge({ author }: { author: string }) {
  return (
    <span className="mb-1 inline-block rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-medium text-brand">
      via {author}
    </span>
  );
}

export function MessageView({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl bg-brand px-4 py-2 text-sm text-white">
          {message.content}
        </div>
      </div>
    );
  }

  if (message.role === "tool") {
    return (
      <div className="flex justify-start">
        <div className="w-full max-w-[80%]">
          <ToolResultBlock content={message.content} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl border border-neutral-200 bg-white px-4 py-2 text-sm text-neutral-800 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100">
        {message.content}
      </div>
    </div>
  );
}

export function LiveAssistant({ turn }: { turn: LiveTurn }) {
  return (
    <div className="flex flex-col items-start gap-1">
      {turn.tools.map((tool, index) => (
        <div key={index} className="w-full max-w-[80%]">
          <ToolResultBlock content={tool} />
        </div>
      ))}
      <div className="max-w-[80%]">
        {turn.author && <AuthorBadge author={turn.author} />}
        <div className="whitespace-pre-wrap break-words rounded-2xl border border-neutral-200 bg-white px-4 py-2 text-sm text-neutral-800 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100">
          {turn.text || <span className="text-neutral-400">Thinking…</span>}
        </div>
      </div>
    </div>
  );
}

export function Composer({
  onSend,
  disabled,
  placeholder,
}: {
  onSend: (content: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [value, setValue] = useState("");

  function submit() {
    const trimmed = value.trim();
    if (!trimmed || disabled) {
      return;
    }
    setValue("");
    onSend(trimmed);
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="flex items-end gap-2"
    >
      <textarea
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
        rows={1}
        placeholder={placeholder ?? "Send a message…"}
        className="max-h-40 min-h-[42px] flex-1 resize-y rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none focus:border-brand dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
      />
      <button
        type="submit"
        disabled={disabled || !value.trim()}
        className="rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-50"
      >
        Send
      </button>
    </form>
  );
}
