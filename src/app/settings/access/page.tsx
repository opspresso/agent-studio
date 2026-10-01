import { SettingsForm } from "../SettingsForm";
import { Stack } from "@mantine/core";
import { MemberTierSettings } from "./MemberTierSettings";

export default function SettingsPage() {
  return <Stack gap="xl"><SettingsForm section="access" /><MemberTierSettings /></Stack>;
}
