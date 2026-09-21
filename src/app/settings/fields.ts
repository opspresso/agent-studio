import type { SettingKey, SettingsView, SettingsUpdate } from "@/application/settings/settingsUseCases";
import type { MessageKey } from "@/app/_i18n/messages/en";

export type SettingsSection = "general" | "plugins" | "keys";
interface FieldLabel {
  key: SettingKey;
  label: MessageKey;
  hint?: MessageKey;
  placeholder?: string;
}
type SettingField = FieldLabel & (
  | { type: "select"; fallback: string; options: readonly { value: string; label: MessageKey }[] }
  | { type: "url" | "emails" | "domains" | "repository" | "text" | "secret" }
);
export const SETTINGS_FIELDS: Record<SettingsSection, SettingField[]> = {
  general: [
    { key: "publicBaseUrl", label: "settings.field.publicUrl", hint: "settings.hint.publicUrl", type: "url", placeholder: "https://studio.example.com" },
    { key: "artifactAccessMode", label: "settings.field.artifactAccess", hint: "settings.hint.artifactAccess", type: "select", fallback: "authenticated", options: [
      { value: "authenticated", label: "settings.artifactAccess.authenticated" },
      { value: "proxied", label: "settings.artifactAccess.proxied" },
      { value: "public", label: "settings.artifactAccess.public" },
    ] },
    { key: "unknownModelPolicy", label: "settings.field.unknownModelPolicy", hint: "settings.hint.unknownModelPolicy", type: "select", fallback: "allow", options: [
      { value: "allow", label: "settings.unknownModelPolicy.allow" },
      { value: "refuse", label: "settings.unknownModelPolicy.refuse" },
    ] },
    { key: "adminEmails", label: "settings.field.adminEmails", hint: "settings.hint.adminEmails", type: "emails", placeholder: "admin@example.com" },
    { key: "allowedEmailDomains", label: "settings.field.emailDomains", hint: "settings.hint.emailDomains", type: "domains", placeholder: "example.com" },
  ],
  plugins: [
    { key: "pluginsRepo", label: "settings.field.pluginRepo", hint: "settings.hint.pluginRepo", type: "repository", placeholder: "opspresso/agent-plugins" },
    { key: "pluginsRepoBranch", label: "settings.field.pluginBranch", type: "text", placeholder: "main" },
  ],
  keys: [
    { key: "githubToken", label: "settings.field.githubToken", hint: "settings.hint.githubToken", type: "secret" },
  ],
};

/** A tab submits only fields its editor changed, including an intentional override reset. */
export function settingsPatch(section: SettingsSection, values: Partial<Record<SettingKey, string>>, view: SettingsView): SettingsUpdate {
  return Object.fromEntries(SETTINGS_FIELDS[section].flatMap(({ key }) => {
    const value = values[key];
    return value !== undefined && value !== view.fields[key].value ? [[key, value]] : [];
  }));
}
