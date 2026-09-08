import type { Translate } from "@/app/_i18n/translate";
import { decodeArtifactHtml, escapeHtml } from "./htmlSafety";

/** Original code exists only in an escaped srcdoc attribute, never in the wrapper DOM. */
export function interactiveHtml(bytes: Uint8Array, mimeType: string, filename: string | undefined, t: Translate): string | null {
  const source = decodeArtifactHtml(bytes, mimeType);
  if (source === null) return null;
  const title = escapeHtml(filename ?? t("artifacts.preview.title"));
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><style>
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; height: 100vh; height: 100dvh; display: flex; flex-direction: column; }
header { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 16px; padding: 10px 16px; border-bottom: 1px solid #8885; }
header strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: min(100%, 40rem); }
header p { margin: 0; font-size: 12px; opacity: .75; flex: 1 1 240px; }
nav { display: flex; gap: 8px; }
button { font: inherit; padding: 6px 12px; cursor: pointer; }
main { flex: 1; min-height: 0; }
iframe { display: block; width: 100%; height: 100%; border: 0; background: white; }
#stopped { padding: 24px; }
</style></head><body>
<header><strong>${title}</strong><p>${escapeHtml(t("artifacts.preview.note"))}</p>
<nav aria-label="${escapeHtml(t("artifacts.preview.controls"))}"><button id="stop" type="button" disabled>${escapeHtml(t("artifacts.preview.stop"))}</button><button id="restart" type="button" data-restart="${escapeHtml(t("artifacts.preview.restart"))}">${escapeHtml(t("artifacts.preview.run"))}</button></nav></header>
<p id="stopped" role="status" data-stopped="${escapeHtml(t("artifacts.preview.stopped"))}" data-error="${escapeHtml(t("artifacts.preview.error"))}">${escapeHtml(t("artifacts.preview.ready"))}</p>
<main id="stage"></main>
<noscript>${escapeHtml(t("artifacts.preview.noScript"))}</noscript>
<template id="document"><iframe title="${title}" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${escapeHtml(source)}"></iframe></template>
<script>
(() => {
  const stage = document.getElementById('stage');
  const template = document.getElementById('document');
  const stopped = document.getElementById('stopped');
  const stop = document.getElementById('stop');
  const run = document.getElementById('restart');
  let errorShown = false;
  const restart = () => {
    const frame = template.content.firstElementChild.cloneNode(true);
    const content = new DOMParser().parseFromString(frame.srcdoc, 'text/html');
    const monitor = document.createElement('script');
    monitor.textContent = "(() => { const notify = () => parent.postMessage({kind: 'artifact-script-error'}, '*'); addEventListener('error', event => { if (event instanceof ErrorEvent) notify(); }); addEventListener('unhandledrejection', notify); })();";
    // A srcdoc otherwise resolves fragment links against the wrapper URL.
    const base = document.createElement('base');
    base.href = 'about:srcdoc';
    Document.prototype.querySelector.call(content, 'head').prepend(base, monitor);
    frame.srcdoc = '<!doctype html>' + Document.prototype.querySelector.call(content, 'html').outerHTML;
    errorShown = false;
    stage.replaceChildren(frame);
    stopped.hidden = true;
    stop.disabled = false;
    run.textContent = run.dataset.restart;
  };
  stop.addEventListener('click', () => {
    stage.replaceChildren();
    stopped.textContent = stopped.dataset.stopped;
    stopped.hidden = false;
    stop.disabled = true;
  });
  window.addEventListener('message', event => {
    const frame = stage.querySelector('iframe');
    if (!errorShown && frame && event.source === frame.contentWindow && event.data?.kind === 'artifact-script-error') {
      errorShown = true;
      stopped.textContent = stopped.dataset.error;
      stopped.hidden = false;
    }
  });
  run.addEventListener('click', restart);
})();
</script></body></html>`;
}
