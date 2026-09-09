export function nextUpdatedAt(previous: string, now = Date.now()): string {
  const previousTime = Date.parse(previous);
  return new Date(Number.isNaN(previousTime) ? now : Math.max(now, previousTime + 1)).toISOString();
}
