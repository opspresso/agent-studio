import type { Translate } from "@/app/_i18n/translate";
import { decodeArtifactHtml, escapeHtml } from "./htmlSafety";

// Capture native references before the artifact can shadow their global names.
const CHILD_MONITOR = `
(() => {
  const send = parent.postMessage.bind(parent);
  const RuntimeErrorEvent = ErrorEvent;
  const notify = kind => send({kind}, '*');
  addEventListener('error', event => { if (event instanceof RuntimeErrorEvent) notify('artifact-script-error'); });
  addEventListener('unhandledrejection', () => notify('artifact-script-error'));
  addEventListener('securitypolicyviolation', () => notify('artifact-policy-blocked'));
})();`;

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
<nav aria-label="${escapeHtml(t("artifacts.preview.controls"))}"><button id="stop" type="button" disabled>${escapeHtml(t("artifacts.preview.stop"))}</button><button id="restart" type="button">${escapeHtml(t("artifacts.preview.restart"))}</button></nav></header>
<p id="stopped" role="status" data-stopped="${escapeHtml(t("artifacts.preview.stopped"))}" data-error="${escapeHtml(t("artifacts.preview.error"))}" data-blocked="${escapeHtml(t("artifacts.preview.blocked"))}" hidden></p>
<main id="stage"></main>
<noscript>${escapeHtml(t("artifacts.preview.noScript"))}</noscript>
<template id="document"><iframe title="${title}" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${escapeHtml(source)}"></iframe></template>
<script>
(() => {
  const stage = document.getElementById('stage');
  const template = document.getElementById('document');
  const stopped = document.getElementById('stopped');
  const stop = document.getElementById('stop');
  const restartButton = document.getElementById('restart');
  let shownNotice = '';
  const showNotice = kind => {
    if (shownNotice === 'error' || shownNotice === kind) return;
    shownNotice = kind;
    stopped.textContent = kind === 'error' ? stopped.dataset.error : stopped.dataset.blocked;
    stopped.hidden = false;
  };
  const restart = () => {
    const frame = template.content.firstElementChild.cloneNode(true);
    const content = new DOMParser().parseFromString(frame.srcdoc, 'text/html');
    const monitor = document.createElement('script');
    monitor.textContent = ${JSON.stringify(CHILD_MONITOR).replace(/</g, "\\u003c")};
    // A srcdoc otherwise resolves fragment links against the wrapper URL.
    const base = document.createElement('base');
    base.href = 'about:srcdoc';
    Document.prototype.querySelector.call(content, 'head').prepend(base, monitor);
    frame.srcdoc = '<!doctype html>' + Document.prototype.querySelector.call(content, 'html').outerHTML;
    shownNotice = '';
    stage.replaceChildren(frame);
    stopped.hidden = true;
    stop.disabled = false;
  };
  stop.addEventListener('click', () => {
    stage.replaceChildren();
    stopped.textContent = stopped.dataset.stopped;
    stopped.hidden = false;
    stop.disabled = true;
  });
  window.addEventListener('message', event => {
    const frame = stage.querySelector('iframe');
    if (!frame || event.source !== frame.contentWindow) return;
    if (event.data?.kind === 'artifact-script-error') showNotice('error');
    else if (event.data?.kind === 'artifact-policy-blocked') showNotice('blocked');
  });
  document.addEventListener('securitypolicyviolation', event => {
    if (event.isTrusted && event.effectiveDirective === 'frame-src' && stage.querySelector('iframe')) showNotice('blocked');
  });
  restartButton.addEventListener('click', restart);
  restart();
})();
</script></body></html>`;
}
