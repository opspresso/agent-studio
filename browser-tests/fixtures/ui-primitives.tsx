import { createRoot } from "react-dom/client";
import { useState } from "react";
import { Badge, Button, Group, Paper, Stack } from "@mantine/core";
import "@mantine/core/styles.css";
import "../../src/app/globals.css";
import { I18nProvider } from "../../src/app/_i18n/provider";
import { ConsoleThemeProvider } from "../../src/app/_components/ConsoleThemeProvider";
import { BADGE } from "../../src/app/_components/badgeColors";
import { SearchSelectInput } from "../../src/app/agents/[name]/_components/inputs";
import { SignInButton } from "../../src/components/SignInButton";
import { CodeBlock } from "../../src/app/_components/CodeBlock";

function Pickers() {
  const [values, setValues] = useState(["first", "second"]);
  return <SearchSelectInput label="Skills" values={values} onChange={setValues}
    options={["first", "second", "third"].map(value => ({ value }))} />;
}

document.documentElement.style.setProperty("--font-sans", "system-ui");
const query = new URLSearchParams(location.search);
createRoot(document.getElementById("root")!).render(<I18nProvider locale={query.get("locale") === "ko" ? "ko" : "en"}><ConsoleThemeProvider>
  <Paper p="lg" m="lg">{query.get("page") === "sign-in" ? <SignInButton providers={{ password: true, keycloak: false, google: false, oidc: undefined }} />
    : query.get("page") === "pickers" ? <Pickers /> : <Stack>{Object.entries(BADGE).map(([tone,color]) => <Group key={tone}>
    <Badge color={color} data-testid={`badge-${tone}`}>{tone}</Badge>
    <Button color={color} variant="light" data-testid={`light-${tone}`}>{tone}</Button>
    <Button color={color} data-testid={`filled-${tone}`}>{tone}</Button>
  </Group>)}
    <CodeBlock language="javascript" code={'// Sample request\nconst result = fetch("$ENDPOINT", 42);'} />
    <CodeBlock language="json" code={'{"message": "value", "count": 42}'} />
  </Stack>}</Paper>
</ConsoleThemeProvider></I18nProvider>);
