import { Text } from "@mantine/core";
import classes from "./CatalogHelp.module.css";

/** Keep registry guidance available without putting a paragraph before every list. */
export function CatalogHelp({ title, children }: { title: string; children: React.ReactNode }) {
  return <details className={classes.help}>
    <summary>{title}</summary>
    <Text fz="sm" c="dimmed" mt="sm">{children}</Text>
  </details>;
}
