"use client";

/**
 * Starting a managed MCP server.
 *
 * There is no address field, and that absence is the point: a managed entry is
 * trusted because the provisioner reported where it bound the port, so letting
 * anyone type one here would put the claim back in an operator's hands. The
 * form takes declarative workload and registry settings, and nothing that could
 * become a command.
 */

import { useState } from "react";
import {
  Alert,
  Button,
  Code,
  Group,
  Modal,
  NumberInput,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { monoInput } from "@/app/_components/monoInput";
import { HeaderRowsEditor, rowsToRecord, type HeaderRow } from "@/app/_components/HeaderRows";
import { createManagedMcp } from "../api";


export function ManagedMcpModal({
  opened,
  onClose,
  onCreated,
}: {
  opened: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [image, setImage] = useState("");
  const [containerPort, setContainerPort] = useState("3000");
  const [envRefs, setEnvRefs] = useState("");
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
    setDescription("");
    setContent("");
    setRows([]);
  }

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
        ...(content ? { content } : {}),
        headers: rowsToRecord(rows),
      });
      reset();
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start the server");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title="Run a managed MCP server" size="lg">
      <form onSubmit={submit}>
        <Stack gap="md">
          {error && (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          )}
          <TextInput
            label="Name"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            placeholder="image-fetch"
            pattern="[a-z0-9][a-z0-9-]*"
            required
            description="Also the container's name, so the two stay findable together."
            inputWrapperOrder={["label", "input", "description", "error"]}
          />
          <TextInput
            label="Image"
            value={image}
            onChange={(e) => setImage(e.currentTarget.value)}
            placeholder="…dkr.ecr.ap-northeast-2.amazonaws.com/mcp-image-fetch:v1.0.1"
            required
            description="Must come from this account's registry."
            inputWrapperOrder={["label", "input", "description", "error"]}
            styles={monoInput}
          />
          <NumberInput
            label="Container port"
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
            label="Environment"
            value={envRefs}
            onChange={(e) => setEnvRefs(e.currentTarget.value)}
            placeholder="/env/prod/mcp-image-fetch"
            description="SSM parameter names, not values — the secrets never pass through here."
            inputWrapperOrder={["label", "input", "description", "error"]}
            styles={monoInput}
          />
          <TextInput
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
            placeholder="Fetches an image URL and returns its bytes"
          />
          <Textarea
            label="Content (markdown)"
            value={content}
            onChange={(e) => setContent(e.currentTarget.value)}
            placeholder="Setup steps, caveats, links…"
            autosize
            minRows={6}
            maxRows={24}
            description="Operator notes for the console. Not sent to the model."
            inputWrapperOrder={["label", "input", "description", "error"]}
            styles={monoInput}
          />

          <HeaderRowsEditor rows={rows} onChange={setRows} />

          <Group
            justify="flex-end"
            gap="sm"
            pt="sm"
            style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}
          >
            <Text fz="xs" c="dimmed" mr="auto">
              Starts a container on this host, reachable only from it.
            </Text>
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={submitting} disabled={!name || !image}>
              Start
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
