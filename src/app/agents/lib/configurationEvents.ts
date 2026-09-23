const EVENT = "studio:project-configuration-changed";

export function notifyConfigurationChange(projectName: string): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(EVENT, { detail: projectName }));
}

export function onConfigurationChange(projectName: string, reload: () => void): () => void {
  const listener = (event: Event) => { if ((event as CustomEvent<string>).detail === projectName) reload(); };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
