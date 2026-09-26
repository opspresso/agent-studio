import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Button, Card, MantineProvider, Stack, Switch } from "@mantine/core";
import "@mantine/core/styles.css";
import { I18nProvider } from "../../src/app/_i18n/provider";
import { SecretControl } from "../../src/app/_components/SecretControl";
import { TokenSection } from "../../src/app/agents/[name]/integrations/TokenSection";
import { SecretInput } from "../../src/app/_components/SecretInput";
import { HeaderRowsEditor, recordToRows, rowsToRecord } from "../../src/app/_components/HeaderRows";
import { theme } from "../../src/app/theme";

const mask = `head${"•".repeat(64)}tail`;

function Fixture() {
  const [stored, setStored] = useState(mask);
  const [draft, setDraft] = useState(mask);
  const [configured, setConfigured] = useState(true);
  const [events, setEvents] = useState<string[]>([]);
  const [fail, setFail] = useState(false);
  const [hold, setHold] = useState(false);
  const [complete, setComplete] = useState<(() => void) | null>(null);
  const [identity, setIdentity] = useState("Agent token");
  const [historySelected, setHistorySelected] = useState(false);
  const [rows, setRows] = useState(() => recordToRows({ Authorization: mask }));
  async function action(name: string) {
    setEvents(current => [...current, name]);
    if (hold) await new Promise<void>(resolve => setComplete(() => resolve));
    if (fail) throw new Error("Credential service unavailable");
  }
  return <MantineProvider theme={theme}><I18nProvider locale="en">
    <Stack maw={760} mx="auto" p="md">
      <Card><SecretInput label="Provider key" value={draft} onChange={setDraft} storedValue={stored} allowReset />
        <Button mt="sm" onClick={() => { setStored(draft ? `next${"•".repeat(64)}tail` : ""); setDraft(draft ? `next${"•".repeat(64)}tail` : ""); }}>Save provider</Button>
        <Button onClick={() => setDraft(stored)}>Save with unchanged mask</Button>
        <output aria-label="Input unchanged">{String(draft === stored)}</output>
      </Card>
      <Card><SecretControl key={identity} label={identity} configured={configured} masked={mask}
        onReveal={async () => { await action("show"); return "synthetic-revealed-key"; }}
        onGenerate={async () => { await action("generate"); setConfigured(true); return "synthetic-generated-key"; }}
        onRevoke={async () => { await action("revoke"); setConfigured(false); }}
        onSave={async () => { await action("save"); setConfigured(true); }}
        onReset={async () => { await action("reset"); setConfigured(false); }} />
      </Card>
      <Card><TokenSection agentName="fixture-agent" selected={historySelected}
        onSelect={() => setHistorySelected(true)} />
        <output aria-label="History selected">{String(historySelected)}</output>
      </Card>
      <Card><HeaderRowsEditor rows={rows} onChange={setRows} />
        <output aria-label="Header unchanged">{String(rowsToRecord(rows).Authorization === mask)}</output>
      </Card>
      <Switch label="Fail operations" checked={fail} onChange={event => setFail(event.currentTarget.checked)} />
      <Switch label="Hold operations" checked={hold} onChange={event => setHold(event.currentTarget.checked)} />
      <Button onClick={() => complete?.()}>Complete operation</Button>
      <Button onClick={() => setIdentity("Other agent token")}>Change agent</Button>
      <output aria-label="Operations">{events.join(",") || "none"}</output>
    </Stack>
  </I18nProvider></MantineProvider>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
