import { Stack, type StackProps } from "@mantine/core";
import classes from "../Playground.module.css";

/** Disable shared configuration controls independently of personal connection actions. */
export function ConfigurationFields({ disabled, gap = "md", children }: {
  disabled: boolean;
  gap?: StackProps["gap"];
  children: React.ReactNode;
}) {
  return <fieldset disabled={disabled} className={classes.configurationFields}>
    <Stack gap={gap}>{children}</Stack>
  </fieldset>;
}
