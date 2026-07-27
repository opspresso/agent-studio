"use client";

/**
 * Starting a managed MCP server.
 *
 * There is no address field, and that absence is the point: a managed entry is
 * trusted because the provisioner reported where it bound the port, so letting
 * anyone type one here would put the claim back in an operator's hands. The
 * form takes an image and the port the container listens on, and nothing that
 * could become a command.
 */

import { useState } from "react";
import { Modal } from "@/app/_components/Modal";
import { buttonClass } from "@/app/_components/buttonStyles";
import { fieldClass, monoFieldClass } from "@/app/_components/formStyles";
import { createManagedMcp } from "../api";

export function ManagedMcpModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [image, setImage] = useState("");
  const [containerPort, setContainerPort] = useState("3000");
  const [envRefs, setEnvRefs] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const refs = envRefs
        .split(/[\s,]+/)
        .map((ref) => ref.trim())
        .filter(Boolean);
      await createManagedMcp({
        name,
        image,
        containerPort: Number(containerPort),
        ...(refs.length > 0 ? { envRefs: refs } : {}),
        ...(description ? { description } : {}),
      });
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start the server");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title="Run a managed MCP server"
      onClose={onClose}
      size="md"
      footer={
        <>
          <p className="mr-auto text-xs text-neutral-400">
            Starts a container on this host, reachable only from it.
          </p>
          <button type="button" onClick={onClose} className={buttonClass("secondary")}>
            Cancel
          </button>
          <button
            type="submit"
            form="managed-mcp"
            disabled={submitting || !name || !image}
            className={buttonClass("primary")}
          >
            {submitting ? "Starting…" : "Start"}
          </button>
        </>
      }
    >
      <form id="managed-mcp" onSubmit={submit} className="space-y-4">
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <label className="block text-sm">
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="image-fetch"
            pattern="[a-z0-9][a-z0-9-]*"
            required
            className={fieldClass}
          />
          <span className="mt-1 block text-xs text-neutral-400">
            Also the container&apos;s name, so the two stay findable together.
          </span>
        </label>
        <label className="block text-sm">
          Image
          <input
            value={image}
            onChange={(e) => setImage(e.target.value)}
            placeholder="…dkr.ecr.ap-northeast-2.amazonaws.com/mcp-image-fetch:v1.0.1"
            required
            className={monoFieldClass}
          />
          <span className="mt-1 block text-xs text-neutral-400">
            Must come from this account&apos;s registry.
          </span>
        </label>
        <label className="block text-sm">
          Container port
          <input
            type="number"
            value={containerPort}
            onChange={(e) => setContainerPort(e.target.value)}
            min={1}
            max={65535}
            required
            className={fieldClass}
          />
          <span className="mt-1 block text-xs text-neutral-400">
            What it listens on inside itself. The deployed runtime shares this app&apos;s
            network namespace rather than mapping ports, so the container is told which
            port to bind and has to honour <code>PORT</code>.
          </span>
        </label>
        <label className="block text-sm">
          Environment
          <input
            value={envRefs}
            onChange={(e) => setEnvRefs(e.target.value)}
            placeholder="/env/prod/mcp-image-fetch"
            className={monoFieldClass}
          />
          <span className="mt-1 block text-xs text-neutral-400">
            SSM parameter names, not values — the secrets never pass through here.
          </span>
        </label>
        <label className="block text-sm">
          Description
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Fetches an image URL and returns its bytes"
            className={fieldClass}
          />
        </label>
      </form>
    </Modal>
  );
}
