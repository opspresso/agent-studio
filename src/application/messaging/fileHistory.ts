import type { ConversationTranscriptRepository } from "@/domain/messaging/transcript";
import { conversationKey, type RunActor, type RunConversation } from "@/domain/execution/actor";
import { fileReferenceText, type ProducedFile } from "@/application/artifact/producedFiles";
import { log } from "@/shared/logger";

const FILE_HISTORY_TURNS = 20;
const MAX_FILE_REFERENCES_PER_TURN = 20;
const MAX_FILE_HISTORY_CHARS = 20_000;
function key(conversation: RunConversation, actor: RunActor): string {
  return JSON.stringify(["files", conversationKey(conversation), actor.kind, actor.id]);
}

/** The platform's text history need not contain IDs for files whose links it displays. */
export async function loadFileHistory(
  repository: ConversationTranscriptRepository | undefined,
  project: string, conversation: RunConversation, actor: RunActor | undefined, warnings: string[],
): Promise<string> {
  if (!repository || !actor) return "";
  try {
    const turns = await repository.recent(project, key(conversation, actor), FILE_HISTORY_TURNS);
    const kept: string[] = [];
    let chars = 0;
    for (let index = turns.length - 1; index >= 0; index--) {
      const text = turns[index]!.content;
      if (chars + text.length + 1 > MAX_FILE_HISTORY_CHARS) {
        warnings.push("Older file references were omitted to fit this run's context budget.");
        break;
      }
      kept.unshift(text);
      chars += text.length + 1;
    }
    return kept.join("\n");
  } catch (error) {
    log.error("messaging", "could not read prior file references", error);
    warnings.push("Earlier file references could not be restored for this run.");
    return "";
  }
}

export async function rememberFiles(
  repository: ConversationTranscriptRepository | undefined,
  project: string, conversation: RunConversation, actor: RunActor | undefined, files: ProducedFile[], warnings: string[],
): Promise<void> {
  if (!repository || !actor) return;
  const referenced = files.filter((file) => file.fileId);
  if (referenced.length > MAX_FILE_REFERENCES_PER_TURN) warnings.push(`Only the newest ${MAX_FILE_REFERENCES_PER_TURN} output file references are kept for later questions.`);
  const content = fileReferenceText(referenced.slice(-MAX_FILE_REFERENCES_PER_TURN));
  if (!content) return;
  try {
    await repository.append(project, key(conversation, actor), {
      role: "assistant", content, createdAt: new Date().toISOString(),
    });
  } catch (error) {
    log.error("messaging", "could not retain file references", error);
    warnings.push("File references could not be kept for later questions.");
  }
}
