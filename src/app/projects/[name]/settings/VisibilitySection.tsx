"use client";

import { useEffect, useState } from "react";
import { Alert, Badge, Button, Group, Radio, Stack, TagsInput, Text } from "@mantine/core";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { getProject, updateProject, type ProjectVisibility } from "../../lib/api";
import { useT } from "@/app/_i18n/provider";

/**
 * Who may see and run the project. Public is what every project was before
 * visibility existed; private narrows access to the owner and the invited
 * emails, which only matter — and are only shown — while private is selected.
 */
export function VisibilitySection({ projectName }: { projectName: string }) {
  const t = useT();
  const [visibility, setVisibility] = useState<ProjectVisibility>("public");
  const [memberEmails, setMemberEmails] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  /**
   * Save stays locked until the stored state has actually been read: saving
   * off the defaults after a failed load would flip a private project public
   * and replace its invite list with [] in one click.
   */
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getProject(projectName)
      .then((project) => {
        if (!cancelled) {
          setVisibility(project.visibility ?? "public");
          setMemberEmails(project.memberEmails ?? []);
          setLoaded(true);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load project");
        }
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [projectName]);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const project = await updateProject(projectName, { visibility, memberEmails });
      setVisibility(project.visibility ?? "public");
      // The server normalizes (trim, lowercase, dedupe, owner dropped); show
      // what was actually stored rather than what was typed.
      setMemberEmails(project.memberEmails ?? []);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <CollapsibleSection
      title={t("pset.visibility")}
      badge={
        !loading ? (
          visibility === "private" ? (
            <Badge variant="light" color="gray">
              {t("projects.privateBadge")}
            </Badge>
          ) : (
            <Badge variant="light" color="teal">
              {t("pset.visibilityPublic")}
            </Badge>
          )
        ) : undefined
      }
    >
      <Stack gap="md">
        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}
        <Radio.Group
          value={visibility}
          onChange={(value) => setVisibility(value as ProjectVisibility)}
        >
          <Stack gap="xs">
            <Radio
              value="public"
              label={t("pset.visibilityPublic")}
              description={t("pset.visibilityPublicHint")}
            />
            <Radio
              value="private"
              label={t("pset.visibilityPrivate")}
              description={t("pset.visibilityPrivateHint")}
            />
          </Stack>
        </Radio.Group>
        {visibility === "private" && (
          <TagsInput
            label={t("pset.invitedMembers")}
            description={t("pset.invitedMembersHint")}
            placeholder="colleague@example.com"
            value={memberEmails}
            onChange={setMemberEmails}
            splitChars={[",", " "]}
          />
        )}
        <Group gap="sm">
          <Button onClick={save} loading={saving} disabled={loading || !loaded}>
            {t("pset.visibilitySave")}
          </Button>
          {saved && (
            <Text fz="sm" c="teal">
              Saved
            </Text>
          )}
        </Group>
      </Stack>
    </CollapsibleSection>
  );
}
