import type { SettingKey, SettingsView, SettingsUpdate } from "@/application/settings/settingsUseCases";
import type { MessageKey } from "@/app/_i18n/messages/en";

export type SettingsSection = "general" | "plugins" | "keys";
interface SettingField {
  key: SettingKey;
  label: MessageKey;
  hint?: MessageKey;
  type: "url" | "emails" | "domains" | "artifactAccess" | "repository" | "text" | "secret";
  placeholder?: string;
}
export const SETTINGS_FIELDS: Record<SettingsSection, SettingField[]> = {
  general: [
    { key: "publicBaseUrl", label: "settings.field.publicUrl", hint: "settings.hint.publicUrl", type: "url", placeholder: "https://studio.example.com" },
    { key: "artifactAccessMode", label: "settings.field.artifactAccess", hint: "settings.hint.artifactAccess", type: "artifactAccess" },
    { key: "adminEmails", label: "settings.field.adminEmails", hint: "settings.hint.adminEmails", type: "emails", placeholder: "admin@example.com" },
    { key: "allowedEmailDomains", label: "settings.field.emailDomains", hint: "settings.hint.emailDomains", type: "domains", placeholder: "example.com" },
  ],
  plugins: [
    { key: "pluginsRepo", label: "settings.field.pluginRepo", hint: "settings.hint.pluginRepo", type: "repository", placeholder: "opspresso/agent-plugins" },
    { key: "pluginsRepoBranch", label: "settings.field.pluginBranch", type: "text", placeholder: "main" },
  ],
  keys: [
    { key: "githubToken", label: "settings.field.githubToken", hint: "settings.hint.githubToken", type: "secret" },
    { key: "a2aApiKey", label: "settings.field.a2aKey", hint: "settings.hint.a2aKey", type: "secret" },
  ],
};

/** A tab submits only fields its editor changed, including an intentional override reset. */
export function settingsPatch(section: SettingsSection, values: Partial<Record<SettingKey, string>>, view: SettingsView): SettingsUpdate {
  return Object.fromEntries(SETTINGS_FIELDS[section].flatMap(({ key }) => {
    const value = values[key];
    return value !== undefined && value !== view.fields[key].value ? [[key, value]] : [];
  }));
}
