import { createRoot } from "react-dom/client";
import { Badge, Button, Group, Paper, Stack } from "@mantine/core";
import "@mantine/core/styles.css";
import "../../src/app/globals.css";
import { I18nProvider } from "../../src/app/_i18n/provider";
import { ConsoleThemeProvider } from "../../src/app/_components/ConsoleThemeProvider";
import { BADGE } from "../../src/app/_components/badgeColors";

document.documentElement.style.setProperty("--font-sans", "system-ui");
createRoot(document.getElementById("root")!).render(<I18nProvider locale="en"><ConsoleThemeProvider>
  <Paper p="lg" m="lg"><Stack>{Object.entries(BADGE).map(([tone,color]) => <Group key={tone}>
    <Badge color={color} data-testid={`badge-${tone}`}>{tone}</Badge>
    <Button color={color} variant="light" data-testid={`light-${tone}`}>{tone}</Button>
    <Button color={color} data-testid={`filled-${tone}`}>{tone}</Button>
  </Group>)}</Stack></Paper>
</ConsoleThemeProvider></I18nProvider>);
