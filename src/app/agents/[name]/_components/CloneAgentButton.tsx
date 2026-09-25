"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, TextInput } from "@mantine/core";
import { IconCopy } from "@tabler/icons-react";
import { useDisclosure } from "@mantine/hooks";
import { FormModal } from "@/app/_components/FormModal";
import { toSlug } from "@/domain/naming";
import { useT } from "@/app/_i18n/provider";
import { cloneAgent } from "../../lib/api";
import { reportError } from "@/app/_lib/reportError";

/**
 * Clone this agent into one the caller owns. Anyone who can see the agent
 * may clone it — that is one of the things access grants — so the button sits
 * in the header rather than behind the owner-gated settings tab. The server
 * still decides: a tier that may not create agents gets the same 403 the
 * "New agent" button hides.
 */
export function CloneAgentButton({ sourceName }: { sourceName: string }) {
  const t = useT();
  const router = useRouter();
  const [opened, { open, close }] = useDisclosure(false);
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const { agent, warning } = await cloneAgent(sourceName, {
        name,
        displayName: displayName || name,
      });
      if (warning) {
        // The clone exists but arrived incomplete. Stay here and say what was
        // lost — navigating away would show an empty playground with no
        // explanation, which reads as a bug rather than a reported loss.
        setError(warning);
        return;
      }
      close();
      router.push(`/agents/${agent.name}`);
    } catch (err) {
      setError(reportError(err, t("agents.cloneFailed")));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Button variant="default" leftSection={<IconCopy size={15} />} onClick={open}>
        {t("agent.clone")}
      </Button>
      <FormModal
        opened={opened}
        onClose={close}
        title={t("agent.cloneTitle", { name: sourceName })}
        error={error}
        onSubmit={submit}
        submitLabel={t("agent.clone")}
        submitting={submitting}
      >
        <TextInput
          label={t("agents.name")}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          onBlur={() => setName(toSlug(name))}
          placeholder={`${sourceName}-copy`}
          required
          description={t("agents.nameHint")}
          inputWrapperOrder={["label", "input", "description", "error"]}
        />
        <TextInput
          label={t("agents.displayName")}
          value={displayName}
          onChange={(e) => setDisplayName(e.currentTarget.value)}
          placeholder={t("agents.displayNamePlaceholder")}
        />
      </FormModal>
    </>
  );
}
