import { SettingsForm } from "../SettingsForm";
import { Stack } from "@mantine/core";
import { CapabilityVisibilitySettings } from "./CapabilityVisibilitySettings";

export default function SettingsPage() {
  return <Stack gap="xl"><SettingsForm section="plugins" /><CapabilityVisibilitySettings /></Stack>;
}
