/** Runtime error results use this prefix; display and tracing must classify the same result. */
export function isToolErrorText(content: string): boolean {
  return content.startsWith("Error:");
}
