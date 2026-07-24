"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useSession } from "@/lib/auth-client";
import { CopyButton } from "@/app/_components/CopyButton";
import { CodeBlock } from "@/app/_components/CodeBlock";
import { getProject, getProjectA2a, getProjectSlack } from "../../lib/api";
import {
  AUTH_LABEL,
  buildApiReference,
  type ApiEndpoint,
  type ApiReferenceContext,
  type CodeExample,
  type FieldSpec,
} from "./endpoints";

const METHOD_CLASS: Record<ApiEndpoint["method"], string> = {
  GET: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  POST: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
};

function FieldRows({ fields, depth = 0 }: { fields: FieldSpec[]; depth?: number }) {
  return (
    <>
      {fields.map((field) => (
        <tr key={`${depth}-${field.name}`} className="align-top">
          <td className="py-1.5 pr-4 font-mono" style={depth > 0 ? { paddingLeft: depth * 16 } : undefined}>
            {depth > 0 && <span className="text-neutral-400">└ </span>}
            {field.name}
            {field.required && <span className="ml-1 text-red-500">*</span>}
          </td>
          <td className="py-1.5 pr-4 font-mono text-neutral-500">{field.type}</td>
          <td className="py-1.5 text-neutral-500">{field.description}</td>
        </tr>
      ))}
      {fields.map((field) =>
        field.children ? (
          <FieldRows key={`c-${depth}-${field.name}`} fields={field.children} depth={depth + 1} />
        ) : null,
      )}
    </>
  );
}

function FieldTable({ label, fields }: { label: string; fields: FieldSpec[] }) {
  return (
    <div className="space-y-1">
      <span className="text-xs font-medium uppercase text-neutral-500">{label}</span>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-left text-neutral-400">
            <tr>
              <th className="py-1 pr-4 font-medium">Field</th>
              <th className="py-1 pr-4 font-medium">Type</th>
              <th className="py-1 font-medium">Description</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800/60">
            <FieldRows fields={fields} />
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CodeExamples({ examples }: { examples: CodeExample[] }) {
  const [active, setActive] = useState(0);
  const current = examples[active] ?? examples[0];
  if (!current) {
    return null;
  }
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1">
          {examples.map((example, index) => (
            <button
              key={example.label}
              type="button"
              onClick={() => setActive(index)}
              className={`rounded-md px-2 py-1 text-xs ${
                index === active
                  ? "bg-neutral-200 font-medium text-neutral-800 dark:bg-neutral-700 dark:text-neutral-100"
                  : "text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
              }`}
            >
              {example.label}
            </button>
          ))}
        </div>
        <CopyButton text={current.code} />
      </div>
      <CodeBlock language={current.language} code={current.code} />
    </div>
  );
}

function ResponseExample({ code }: { code: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase text-neutral-500">Response example</span>
        <CopyButton text={code} />
      </div>
      <CodeBlock language="json" code={code} />
    </div>
  );
}

function EndpointCard({ endpoint }: { endpoint: ApiEndpoint }) {
  return (
    <div className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`rounded px-2 py-0.5 font-mono text-xs font-medium ${METHOD_CLASS[endpoint.method]}`}
          >
            {endpoint.method}
          </span>
          <code className="min-w-0 flex-1 truncate font-mono text-sm" title={endpoint.path}>
            {endpoint.path}
          </code>
          {endpoint.streaming && (
            <span className="rounded-full bg-neutral-200 px-2 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800">
              SSE
            </span>
          )}
        </div>
        <p className="text-sm font-medium">{endpoint.title}</p>
        <p className="text-xs leading-relaxed text-neutral-500">{endpoint.description}</p>
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-neutral-500">
        <span>
          Auth: <span className="text-neutral-700 dark:text-neutral-300">{AUTH_LABEL[endpoint.auth]}</span>
        </span>
        {endpoint.errorCodes.length > 0 && (
          <span>
            Errors:{" "}
            <span className="font-mono text-neutral-700 dark:text-neutral-300">
              {endpoint.errorCodes.join(" · ")}
            </span>
          </span>
        )}
      </div>

      {endpoint.requestFields && <FieldTable label="Request" fields={endpoint.requestFields} />}
      <CodeExamples examples={endpoint.codeExamples} />
      {endpoint.responseFields && <FieldTable label="Response" fields={endpoint.responseFields} />}
      {endpoint.responseExample && <ResponseExample code={endpoint.responseExample} />}
    </div>
  );
}

export default function ApiReferencePage() {
  const { name } = useParams<{ name: string }>();
  const { data: session } = useSession();
  const [endpoints, setEndpoints] = useState<ApiEndpoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const project = await getProject(name);
        const isOwner = session?.user.email === project.ownerEmail;

        const [a2a, slack] = await Promise.all([
          getProjectA2a(name).catch(() => null),
          isOwner ? getProjectSlack(name).catch(() => null) : Promise.resolve(null),
        ]);

        const ctx: ApiReferenceContext = {
          projectName: project.name,
          projectType: project.projectType,
          publishedVersion: project.publishedVersion ?? null,
          origin: typeof window === "undefined" ? "" : window.location.origin,
          a2a: a2a ? { enabled: a2a.enabled, published: a2a.published } : null,
          slack: slack ? { configured: slack.configured } : null,
        };

        if (!cancelled) {
          setEndpoints(buildApiReference(ctx));
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load API reference");
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [name, session?.user.email]);

  if (error) {
    return <p className="text-sm text-red-600">{error}</p>;
  }
  if (!endpoints) {
    return <p className="text-sm text-neutral-500">Loading…</p>;
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-neutral-500">
        Endpoints for calling this project from outside the console. Paths are filled in with the
        project name and its published version; replace{" "}
        <code className="font-mono text-xs">$PROJECT_API_TOKEN</code> and other{" "}
        <code className="font-mono text-xs">$…</code> placeholders with your own credentials. Generate
        a token under Settings → API token.
      </p>
      {endpoints.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No callable endpoints yet — publish a version to expose this project.
        </p>
      ) : (
        endpoints.map((endpoint) => <EndpointCard key={endpoint.id} endpoint={endpoint} />)
      )}
    </div>
  );
}
