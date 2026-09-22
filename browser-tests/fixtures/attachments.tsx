import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Button, MantineProvider, Stack, Textarea } from "@mantine/core";
import "@mantine/core/styles.css";
import { I18nProvider } from "../../src/app/_i18n/provider";
import { AttachButton, AttachmentBar, onFilePaste, useAttachments, useFileDrop } from "../../src/app/_components/ImageAttachments";

interface PendingRead {
  name: string;
  finish: (outcome: "load" | "error" | "abort") => void;
}
declare global {
  interface Window {
    attachmentReads: {
      automatic: boolean;
      calls: string[];
      aborts: string[];
      readonly pending: string[];
      finish: (name: string, outcome?: "load" | "error" | "abort") => void;
      finishAll: () => void;
    };
  }
}

// Keep native FileReader I/O and count every read. Only completion delivery is
// held, so tests can order gestures, read failures and clears deterministically.
const queued: PendingRead[] = [];
const names = new WeakMap<FileReader, string>();
window.attachmentReads = {
  automatic: true,
  calls: [],
  aborts: [],
  get pending() { return queued.map(read => read.name); },
  finish(name, outcome = "load") {
    const index = queued.findIndex(read => read.name === name);
    if (index < 0) throw new Error(`No pending read for ${name}`);
    queued.splice(index, 1)[0]!.finish(outcome);
  },
  finishAll() {
    this.automatic = true;
    for (const read of queued.splice(0)) read.finish("load");
  },
};
const nativeRead = FileReader.prototype.readAsDataURL;
const nativeAbort = FileReader.prototype.abort;
FileReader.prototype.readAsDataURL = function (file: Blob) {
  const name = (file as File).name;
  names.set(this, name);
  window.attachmentReads.calls.push(name);
  const handlers = { load: this.onload, error: this.onerror, abort: this.onabort };
  this.onload = event => {
    const finish = (outcome: "load" | "error" | "abort") => {
      handlers[outcome]?.call(this, outcome === "load" ? event : new ProgressEvent(outcome) as ProgressEvent<FileReader>);
    };
    if (window.attachmentReads.automatic) finish("load");
    else queued.push({ name, finish });
  };
  nativeRead.call(this, file);
};
FileReader.prototype.abort = function () {
  window.attachmentReads.aborts.push(names.get(this) ?? "unknown");
  nativeAbort.call(this);
};

function Attachments() {
  const { attachments, documents, attachError, reading, addFiles, removeAt, removeDocumentAt, clear } = useAttachments({ documents: true });
  const add = (files: File[]) => { void addFiles(files); };
  const { handlers } = useFileDrop(add);
  return <Stack role="region" aria-label="Attachment composer" {...handlers}>
    <AttachButton onPick={add} documents />
    <Textarea aria-label="Paste files" onPaste={onFilePaste(add)} />
    <AttachmentBar attachments={attachments} documents={documents} attachError={attachError} onRemove={removeAt} onRemoveDocument={removeDocumentAt} />
    <output aria-label="Attachment counts">{attachments.length} images, {documents.length} documents</output>
    <output aria-label="Read state">{reading ? "Reading" : "Ready"}</output>
    <Button onClick={clear}>Clear attachments</Button>
  </Stack>;
}

function Fixture() {
  const [mounted, setMounted] = useState(true);
  return <MantineProvider><I18nProvider locale="en"><Stack p="md">
    <Button onClick={() => setMounted(value => !value)}>{mounted ? "Hide composer" : "Show composer"}</Button>
    {mounted && <Attachments />}
  </Stack></I18nProvider></MantineProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
