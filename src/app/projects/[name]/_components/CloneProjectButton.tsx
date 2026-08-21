"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, TextInput } from "@mantine/core";
import { IconCopy } from "@tabler/icons-react";
import { useDisclosure } from "@mantine/hooks";
import { FormModal } from "@/app/_components/FormModal";
import { toSlug } from "@/domain/naming";
import { useT } from "@/app/_i18n/provider";
import { cloneProject } from "../../lib/api";

/**
 * Clone this project into one the caller owns. Anyone who can see the project
 * may clone it — that is one of the things access grants — so the button sits
 * in the header rather than behind the owner-gated settings tab. The server
 * still decides: a tier that may not create projects gets the same 403 the
 * "New project" button hides.
 */
export function CloneProjectButton({ sourceName }: { sourceName: string }) {
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
      const { project, warning } = await cloneProject(sourceName, {
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
      router.push(`/projects/${project.name}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("projects.cloneFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Button variant="default" leftSection={<IconCopy size={15} />} onClick={open}>
        {t("project.clone")}
      </Button>
      <FormModal
        opened={opened}
        onClose={close}
        title={t("project.cloneTitle", { name: sourceName })}
        error={error}
        onSubmit={submit}
        submitLabel={t("project.clone")}
        submitting={submitting}
      >
        <TextInput
          label={t("projects.name")}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          onBlur={() => setName(toSlug(name))}
          placeholder={`${sourceName}-copy`}
          required
          description={t("projects.nameHint")}
          inputWrapperOrder={["label", "input", "description", "error"]}
        />
        <TextInput
          label={t("projects.displayName")}
          value={displayName}
          onChange={(e) => setDisplayName(e.currentTarget.value)}
          placeholder={t("projects.displayNamePlaceholder")}
        />
      </FormModal>
    </>
  );
}
