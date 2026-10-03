import { Stack, type StackProps } from "@mantine/core";
import classes from "./ConfigurationFields.module.css";

/** Keep form controls readable while a shared write or permission rule disables edits. */
export function ConfigurationFields({ disabled, gap = "md", children }: {
  disabled: boolean;
  gap?: StackProps["gap"];
  children: React.ReactNode;
}) {
  return <fieldset disabled={disabled} className={classes.configurationFields}>
    <Stack gap={gap}>{children}</Stack>
  </fieldset>;
}
