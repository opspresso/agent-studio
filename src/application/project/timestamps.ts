export function nextUpdatedAt(previous: string): string {
  const now = Date.now();
  const previousTime = Date.parse(previous);
  return new Date(Number.isNaN(previousTime) ? now : Math.max(now, previousTime + 1)).toISOString();
}
