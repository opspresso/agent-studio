"use client";

/**
 * Starting a managed MCP server.
 *
 * There is no address field, and that absence is the point: a managed entry is
 * trusted because the provisioner reported where it bound the port, so letting
 * anyone type one here would put the claim back in an operator's hands. The
 * form takes declarative workload and registry settings. Runtime arguments are
 * kept as an argv list rather than a shell command.
 */

import { useState } from "react";
import { Code, NumberInput, Textarea, TextInput } from "@mantine/core";
import { FormModal } from "@/app/_components/FormModal";
import { monoInput } from "@/app/_components/monoInput";
import { HeaderRowsEditor, rowsToRecord, type HeaderRow } from "@/app/_components/HeaderRows";
import { createManagedMcp } from "../api";
import { MANAGED_NAME } from "@/domain/naming";
import { useT } from "@/app/_i18n/provider";
import { reportError } from "@/app/_lib/reportError";


export function ManagedMcpModal({
  opened,
  onClose,
  onCreated,
}: {
  opened: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [image, setImage] = useState("");
  const [containerPort, setContainerPort] = useState("3000");
  const [envRefs, setEnvRefs] = useState("");
  const [environmentRows, setEnvironmentRows] = useState<HeaderRow[]>([]);
  const [args, setArgs] = useState("");
  const [endpointPath, setEndpointPath] = useState("/mcp");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [rows, setRows] = useState<HeaderRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The modal is mounted for the life of the page — `opened` is a prop, not a
   * mount — so the draft that just started a container is still here when the
   * next one opens, image and SSM refs included.
   */
  function reset() {
    setName("");
    setImage("");
    setContainerPort("3000");
    setEnvRefs("");
    setEnvironmentRows([]);
    setArgs("");
    setEndpointPath("/mcp");
    setDescription("");
    setContent("");
    setRows([]);
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const refs = envRefs
        .split(/[\s,]+/)
        .map((ref) => ref.trim())
        .filter(Boolean);
      const runtimeArgs = args
        .split("\n")
        .map((arg) => arg.trim())
        .filter(Boolean);
      await createManagedMcp({
        name,
        image,
        containerPort: Number(containerPort),
        ...(refs.length > 0 ? { envRefs: refs } : {}),
        environment: rowsToRecord(environmentRows),
        ...(runtimeArgs.length > 0 ? { args: runtimeArgs } : {}),
        endpointPath,
        ...(description ? { description } : {}),
        ...(content ? { content } : {}),
        headers: rowsToRecord(rows),
      });
      reset();
      onCreated();
    } catch (e) {
      setError(reportError(e, "Failed to start the server"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title={t("managed.title")}
      error={error}
      onSubmit={submit}
      submitLabel={t("managed.start")}
      submitting={submitting}
      submitDisabled={!name || !image}
      hint={t("managed.hint")}
    >
      <TextInput
        label={t("registry.nameLabel")}
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
        placeholder={t("managed.namePlaceholder")}
        pattern={MANAGED_NAME.source}
        required
        description={t("managed.nameHint")}
        inputWrapperOrder={["label", "input", "description", "error"]}
      />
      <TextInput
        label={t("managed.image")}
        value={image}
        onChange={(e) => setImage(e.currentTarget.value)}
        placeholder={t("managed.imagePlaceholder")}
        required
        description={t("managed.imageHint")}
        inputWrapperOrder={["label", "input", "description", "error"]}
        styles={monoInput}
      />
      <NumberInput
        label={t("managed.port")}
        value={containerPort}
        onChange={(value) => setContainerPort(String(value))}
        min={1}
        max={65535}
        required
        description={
          <>
            What it listens on inside itself. The deployed runtime shares this app&apos;s
            network namespace rather than mapping ports, so the container is told which port
            to bind and has to honour <Code>PORT</Code>.
          </>
        }
        inputWrapperOrder={["label", "input", "description", "error"]}
      />
      <TextInput
        label={t("managed.envRefs")}
        value={envRefs}
        onChange={(e) => setEnvRefs(e.currentTarget.value)}
        placeholder={t("managed.envRefsPlaceholder")}
        description={t("managed.envRefsHint")}
        inputWrapperOrder={["label", "input", "description", "error"]}
        styles={monoInput}
      />
      <HeaderRowsEditor
        rows={environmentRows}
        onChange={setEnvironmentRows}
        caption={t("managed.envVars")}
        emptyHint={t("managed.envVarsEmpty")}
        addLabel={t("managed.addVariable")}
        keyPlaceholder="VARIABLE_NAME"
        valuePlaceholder="value"
      />
      <Textarea
        label={t("managed.args")}
        value={args}
        onChange={(e) => setArgs(e.currentTarget.value)}
        placeholder={
          "--transport\nstreamable-http\n--address\n0.0.0.0:{{PORT}}\n--allowed-hosts\n*"
        }
        autosize
        minRows={3}
        description={t("managed.argsHint")}
        inputWrapperOrder={["label", "input", "description", "error"]}
        styles={monoInput}
      />
      <TextInput
        label={t("managed.path")}
        value={endpointPath}
        onChange={(e) => setEndpointPath(e.currentTarget.value)}
        placeholder={t("managed.pathPlaceholder")}
        required
        styles={monoInput}
      />
      <TextInput
        label={t("registry.description")}
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
        placeholder={t("tools.descriptionPlaceholder")}
      />
      <Textarea
        label={t("registry.content")}
        value={content}
        onChange={(e) => setContent(e.currentTarget.value)}
        placeholder={t("tools.contentPlaceholder")}
        autosize
        minRows={6}
        maxRows={24}
        description={t("registry.operatorNotes")}
        inputWrapperOrder={["label", "input", "description", "error"]}
        styles={monoInput}
      />

      <HeaderRowsEditor rows={rows} onChange={setRows} />
    </FormModal>
  );
}
