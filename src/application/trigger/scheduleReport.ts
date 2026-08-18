import { splitMessages } from "@/shared/messageCut";

/** Send a completed report as bounded messages without breaking Markdown fences. */
export async function sendScheduleReport(
  text: string,
  limits: { maxChars: number; cutWindow: number },
  send: (piece: string) => Promise<void>,
): Promise<void> {
  for (const piece of splitMessages(text, {
    room: limits.maxChars,
    window: limits.cutWindow,
  })) {
    await send(piece.text);
  }
}
