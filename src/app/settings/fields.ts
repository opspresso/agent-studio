import type { SettingKey, SettingsView, SettingsUpdate } from "@/application/settings/settingsUseCases";
import type { MessageKey } from "@/app/_i18n/messages/en";
import { MAX_RUN_SLOTS } from "@/domain/execution/runSlot";

export type SettingsSection = "service" | "access" | "plugins";
interface FieldLabel {
  key: SettingKey;
  label: MessageKey;
  group?: MessageKey;
  hint?: MessageKey;
  placeholder?: string;
}
type SettingField = FieldLabel & (
  | { type: "select"; fallback: string; options: readonly { value: string; label: MessageKey }[] }
  | { type: "number"; min: number; max: number; step: number }
  | { type: "url" | "emails" | "domains" | "repository" | "text" | "secret" | "logo" }
);
export const SETTINGS_FIELDS: Record<SettingsSection, SettingField[]> = {
  service: [
    { key: "serviceName", label: "settings.field.serviceName", group: "settings.group.branding", hint: "settings.hint.serviceName", type: "text", placeholder: "Agent Studio" },
    { key: "serviceLogo", label: "settings.field.serviceLogo", hint: "settings.hint.serviceLogo", type: "logo" },
    { key: "publicBaseUrl", label: "settings.field.publicUrl", group: "settings.group.delivery", hint: "settings.hint.publicUrl", type: "url", placeholder: "https://studio.example.com" },
    { key: "s3PublicBaseUrl", label: "settings.field.s3PublicUrl", hint: "settings.hint.s3PublicUrl", type: "url", placeholder: "https://objects.example.com/bucket" },
    { key: "artifactAccessMode", label: "settings.field.artifactAccess", hint: "settings.hint.artifactAccess", type: "select", fallback: "authenticated", options: [
      { value: "authenticated", label: "settings.artifactAccess.authenticated" },
      { value: "proxied", label: "settings.artifactAccess.proxied" },
      { value: "public", label: "settings.artifactAccess.public" },
    ] },
    { key: "maxConcurrentRunsPerActor", label: "settings.field.maxConcurrentRuns", group: "settings.group.execution", hint: "settings.hint.maxConcurrentRuns", type: "number", min: 0, max: MAX_RUN_SLOTS, step: 1 },
    { key: "slackLoadingIndicator", label: "settings.field.slackLoading", group: "settings.group.messaging", hint: "settings.hint.slackLoading", type: "text", placeholder: ":hourglass_flowing_sand:" },
  ],
  access: [
    { key: "adminEmails", label: "settings.field.adminEmails", hint: "settings.hint.adminEmails", type: "emails", placeholder: "admin@example.com" },
    { key: "allowedEmailDomains", label: "settings.field.emailDomains", hint: "settings.hint.emailDomains", type: "domains", placeholder: "example.com" },
  ],
  plugins: [
    { key: "pluginsRepo", label: "settings.field.pluginRepo", group: "settings.group.pluginSource", hint: "settings.hint.pluginRepo", type: "repository", placeholder: "opspresso/agent-plugins" },
    { key: "pluginsRepoBranch", label: "settings.field.pluginBranch", type: "text", placeholder: "main" },
    { key: "githubToken", label: "settings.field.githubToken", group: "settings.group.pluginCredentials", hint: "settings.hint.githubToken", type: "secret" },
  ],
};

/** A tab submits only fields its editor changed, including an intentional override reset. */
export function settingsPatch(section: SettingsSection, values: Partial<Record<SettingKey, string>>, view: SettingsView): SettingsUpdate {
  return Object.fromEntries(SETTINGS_FIELDS[section].flatMap(({ key }) => {
    const value = values[key];
    return value !== undefined && value !== view.fields[key].value ? [[key, value]] : [];
  }));
}
