const EVENT = "studio:agent-configuration-changed";

export function notifyConfigurationChange(agentName: string): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(EVENT, { detail: agentName }));
}

export function onConfigurationChange(agentName: string, reload: () => void): () => void {
  const listener = (event: Event) => { if ((event as CustomEvent<string>).detail === agentName) reload(); };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
