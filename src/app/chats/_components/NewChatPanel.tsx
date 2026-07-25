"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { readSse } from "../_lib/sseClient";
import { reduceChunk } from "../_lib/stream";
import { attachmentSrc, toRequestImages, type Attachment } from "@/app/_lib/imageAttachments";
import { EMPTY_TURN, type AgentProject, type LiveTurn } from "../_lib/types";
import { AttachButton, AttachmentBar, useAttachments } from "@/app/_components/ImageAttachments";
import { LiveAssistant, MessageView } from "./parts";
import { refreshChats } from "./ChatSidebar";

export function NewChatPanel() {
  const router = useRouter();
  const [projects, setProjects] = useState<AgentProject[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [message, setMessage] = useState("");
  const [sentMessage, setSentMessage] = useState<{
    content: string;
    attachments: Attachment[];
  } | null>(null);
  // Staged attachments survive an error for a retry, the same way the typed
  // message does; a successful start navigates away and unmounts them.
  const { attachments, attachError, addFiles, removeAt } = useAttachments();
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadProjects() {
      const res = await fetch("/api/projects");
      if (res.ok) {
        const data: unknown = await res.json();
        const list = Array.isArray(data)
          ? (data as AgentProject[])
          : ((data as { projects?: AgentProject[] }).projects ?? []);
        const agents = list.filter((project) => project.projectType === "agent");
        setProjects(agents);
        if (agents.length > 0) {
          setProjectName(agents[0]!.name);
        }
      }
      setProjectsLoaded(true);
    }
    void loadProjects();
  }, []);

  async function start() {
    const trimmed = message.trim();
    if (!projectName || (!trimmed && attachments.length === 0) || starting) {
      return;
    }
    setStarting(true);
    setError(null);
    setSentMessage({ content: trimmed, attachments });
    setLive(EMPTY_TURN);
    let newChatId: string | undefined;
    try {
      const res = await fetch("/api/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectName,
          firstMessage: trimmed,
          images: toRequestImages(attachments),
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `request failed (${res.status})`);
        setSentMessage(null);
        setLive(null);
        return;
      }
      for await (const chunk of readSse(res)) {
        if (chunk.chat) {
          newChatId = chunk.chat.chatId;
          continue;
        }
        if (chunk.error) {
          setError(chunk.error);
          continue;
        }
        setLive((prev) => reduceChunk(prev ?? EMPTY_TURN, chunk));
      }
    } catch (streamError) {
      setError(streamError instanceof Error ? streamError.message : "stream error");
    } finally {
      setStarting(false);
      refreshChats();
      if (newChatId) {
        router.push(`/chats/${newChatId}`);
      }
    }
  }

  if (projectsLoaded && projects.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="max-w-md text-center text-sm text-neutral-500">
          <p className="mb-2 text-base font-medium text-neutral-700 dark:text-neutral-200">
            No agent projects yet
          </p>
          <p>
            Chats run against an <span className="font-medium">agent</span> project. Create one from
            Projects to start chatting.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pb-4">
        {sentMessage === null ? (
          <div className="flex h-full items-center justify-center text-sm text-neutral-500">
            Pick an agent project and send your first message.
          </div>
        ) : (
          <>
            <MessageView
              message={{
                chatId: "",
                seq: 0,
                role: "user",
                content: sentMessage.content,
                images: sentMessage.attachments.map((attachment) => ({
                  url: attachmentSrc(attachment),
                })),
                createdAt: "",
              }}
            />
            {live && <LiveAssistant turn={live} />}
          </>
        )}
      </div>

      {error && (
        <p className="mb-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/40">
          {error}
        </p>
      )}

      <div className="space-y-2 border-t border-neutral-200 pt-3 dark:border-neutral-800">
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-neutral-500">Project</label>
          <select
            value={projectName}
            onChange={(event) => setProjectName(event.target.value)}
            disabled={starting}
            className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          >
            {projects.map((project) => (
              <option key={project.name} value={project.name}>
                {project.displayName || project.name}
              </option>
            ))}
          </select>
        </div>
        <AttachmentBar attachments={attachments} attachError={attachError} onRemove={removeAt} />
        <div className="flex items-end gap-2">
          <AttachButton onPick={(files) => void addFiles(files)} disabled={starting} />
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void start();
              }
            }}
            rows={1}
            placeholder="Send your first message…"
            disabled={starting}
            className="max-h-40 min-h-[42px] flex-1 resize-y rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand dark:border-neutral-700 dark:bg-neutral-900"
          />
          <button
            type="button"
            onClick={() => void start()}
            disabled={starting || (!message.trim() && attachments.length === 0) || !projectName}
            className="rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-50"
          >
            Start
          </button>
        </div>
      </div>
    </div>
  );
}
