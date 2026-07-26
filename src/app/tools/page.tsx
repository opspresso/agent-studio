"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { toSlug } from "@/shared/slug";
import { createMcp, listMcps, type McpServer } from "./api";
import { HeaderRowsEditor, rowsToRecord, type HeaderRow } from "@/app/_components/HeaderRows";
import { ResizableTextarea } from "@/app/_components/ResizableTextarea";
import { Badge } from "@/app/_components/Badge";
import { Modal } from "@/app/_components/Modal";
import { fieldClass, monoFieldClass } from "@/app/_components/formStyles";
import { CardGrid, linkCardClass } from "@/app/_components/CardGrid";
import { ManagedMcpModal } from "./_components/ManagedMcpModal";
import { buttonClass } from "@/app/_components/buttonStyles";

export default function ToolsPage() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [showManaged, setShowManaged] = useState(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setServers(await listMcps());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load MCP servers");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Tools</h1>
          <p className="mt-1 text-sm text-neutral-500">
            MCP servers that expose tools to agents over streamable HTTP.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowManaged(true)}
            className={buttonClass("secondary")}
          >
            Run managed
          </button>
          <button
            type="button"
            onClick={() => setShowModal(true)}
            className={buttonClass("primary")}
          >
            Register MCP
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      )}

      <CardGrid
        loading={loading}
        empty={servers.length === 0}
        emptyText="No MCP servers yet."
      >
        {servers.map((server) => (
          <li key={server.name}>
            <Link
              href={`/tools/${server.name}`}
              className={linkCardClass}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{server.name}</span>
                {server.runtime === "managed" && <Badge>managed</Badge>}
                <CredentialBadges server={server} />
              </div>
              <p className="mt-1 line-clamp-2 text-sm text-neutral-500">
                {server.description || <span className="text-neutral-400">No description</span>}
              </p>
              <p className="mt-2 truncate text-xs text-neutral-400">{server.url}</p>
            </Link>
          </li>
        ))}
      </CardGrid>

      {showManaged && (
        <ManagedMcpModal
          onClose={() => setShowManaged(false)}
          onCreated={() => {
            setShowManaged(false);
            void refresh();
          }}
        />
      )}

      {showModal && (
        <RegisterMcpModal
          onClose={() => setShowModal(false)}
          onCreated={() => {
            setShowModal(false);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

/**
 * How an entry can be authenticated, at a glance.
 *
 * Both badges can appear at once, and the order is the order they are tried at
 * dispatch: a project's OAuth connection first, the entry's own headers as the
 * fallback for projects that have not connected. Neither badge means the entry
 * sends no credential at all, which is worth seeing on a list.
 */
function CredentialBadges({ server }: { server: McpServer }) {
  const headerCount = Object.keys(server.headers ?? {}).length;
  const badges: string[] = [
    ...(server.auth ? ["OAuth"] : []),
    ...(headerCount > 0 ? [`${headerCount} header${headerCount === 1 ? "" : "s"}`] : []),
  ];
  return (
    <>
      {(badges.length === 0 ? ["no credential"] : badges).map((badge) => (
        <Badge key={badge}>{badge}</Badge>
      ))}
    </>
  );
}

function RegisterMcpModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [rows, setRows] = useState<HeaderRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await createMcp({
        name,
        url,
        description: description || undefined,
        content: content || undefined,
        headers: rowsToRecord(rows),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to register MCP server");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Register MCP server" onClose={onClose} size="md">
      <form onSubmit={submit} className="space-y-4">
        <label className="block">
          <span className="text-sm font-medium">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => setName(toSlug(name))}
            placeholder="my-mcp"
            required
            className={fieldClass}
          />
          <span className="mt-1 block text-xs text-neutral-400">
            Lowercase letters, digits, and hyphens only.
          </span>
        </label>
        <label className="block">
          <span className="text-sm font-medium">URL</span>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/mcp"
            type="url"
            required
            className={fieldClass}
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium">Description</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="One-line summary shown to the model"
            className={fieldClass}
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium">Content (markdown)</span>
          <ResizableTextarea
            value={content}
            onChange={setContent}
            rows={6}
            placeholder="Setup steps, caveats, links…"
            className={monoFieldClass}
          />
          <span className="mt-1 block text-xs text-neutral-400">
            Operator notes for the console. Not sent to the model — only the description is.
          </span>
        </label>

        <HeaderRowsEditor rows={rows} onChange={setRows} />

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className={buttonClass("secondary")}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className={buttonClass("primary")}
          >
            {submitting ? "Registering…" : "Register"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
