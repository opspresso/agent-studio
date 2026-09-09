const EVENT = "studio:project-version-changed";

export function notifyVersionChange(projectName: string): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(EVENT, { detail: projectName }));
}

export function onVersionChange(projectName: string, reload: () => void): () => void {
  const listener = (event: Event) => { if ((event as CustomEvent<string>).detail === projectName) reload(); };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
