import { createRoot } from "react-dom/client";
import { useState } from "react";
import { Badge, Button, FileInput, Group, Paper, Select, Stack } from "@mantine/core";
import "@mantine/core/styles.css";
import "../../src/app/globals.css";
import { I18nProvider } from "../../src/app/_i18n/provider";
import { ConsoleThemeProvider } from "../../src/app/_components/ConsoleThemeProvider";
import { BADGE } from "../../src/app/_components/badgeColors";
import { SearchSelectInput } from "../../src/app/agents/[name]/_components/inputs";
import { SignInButton } from "../../src/components/SignInButton";
import { CodeBlock } from "../../src/app/_components/CodeBlock";
import { CredentialBadges } from "../../src/app/tools/_components/CredentialBadges";
import { AppLayout } from "../../src/components/AppLayout";
import { resolveBranding } from "../../src/shared/branding";

function Pickers() {
  const [values, setValues] = useState(["first", "second"]);
  return <SearchSelectInput label="Skills" values={values} onChange={setValues}
    options={["first", "second", "third"].map(value => ({ value }))} />;
}

function Clearing() {
  const [value, setValue] = useState<string | null>("selected");
  const [file, setFile] = useState<File | null>(() => new File(["fixture"], "fixture.mp3", { type: "audio/mpeg" }));
  return <Stack>
    <Select label="Selection" value={value} onChange={setValue} data={["selected"]} clearable allowDeselect={false} />
    <FileInput label="Audio file" value={file} onChange={setFile} clearable />
  </Stack>;
}

document.documentElement.style.setProperty("--font-sans", "system-ui");
const query = new URLSearchParams(location.search);
createRoot(document.getElementById("root")!).render(<I18nProvider locale={query.get("locale") === "ko" ? "ko" : "en"}><ConsoleThemeProvider>
  <Paper p="lg" m="lg">{query.get("page") === "shell" ? <AppLayout branding={resolveBranding()} version="fixture" viewer={{email:"viewer@example.test", tier:"admin", isAdmin:true}}
    userName="Viewer" userImage={null} signInProviders={{ password:false, keycloak:false, google:false, oidc:undefined }}><h1>Agents</h1></AppLayout>
    : query.get("page") === "sign-in" ? <SignInButton providers={{ password: true, keycloak: false, google: false, oidc: undefined }} />
    : query.get("page") === "credentials" ? <Stack><CredentialBadges server={{ headers: {} }} /><CredentialBadges server={{ headers: { "X-Example": "fixture" } }} /></Stack>
    : query.get("page") === "clearing" ? <Clearing />
    : query.get("page") === "pickers" ? <Pickers /> : <Stack>{Object.entries(BADGE).map(([tone,color]) => <Group key={tone}>
    <Badge color={color} data-testid={`badge-${tone}`}>{tone}</Badge>
    <Button color={color} variant="light" data-testid={`light-${tone}`}>{tone}</Button>
    <Button color={color} data-testid={`filled-${tone}`}>{tone}</Button>
  </Group>)}
    <CodeBlock language="javascript" code={'// Sample request\nconst result = fetch("$ENDPOINT", 42);'} />
    <CodeBlock language="json" code={'{"message": "value", "count": 42}'} />
  </Stack>}</Paper>
</ConsoleThemeProvider></I18nProvider>);
