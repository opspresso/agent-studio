import {
  A2A_PROTOCOL_VERSION,
  Role,
  TaskState,
  type AgentCard,
  type Message,
  type SendMessageRequest,
  type Task,
} from "@a2a-js/sdk";
import {
  RequestContext,
  ServerCallContext,
  type AgentExecutionEvent,
  type TaskStore,
} from "@a2a-js/sdk/server";
import { agentMessage, artifact, taskStatus, textPart, userMessage } from "@/domain/a2a/protocol";

export const TEST_CALL_CONTEXT = new ServerCallContext({
  requestedVersion: A2A_PROTOCOL_VERSION,
  tenant: "test",
  user: { isAuthenticated: true, userName: "test-client" },
});

export function messageFixture(text: string, options: { contextId?: string; taskId?: string } = {}): Message {
  return userMessage("m1", [textPart(text)], options);
}

export function agentMessageFixture(text: string, messageId = "m2"): Message {
  return agentMessage(messageId, "c1", "t1", text);
}

export function taskFixture(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    contextId: "c1",
    status: taskStatus(TaskState.TASK_STATE_COMPLETED),
    artifacts: [],
    history: [],
    metadata: undefined,
    ...overrides,
  };
}

export function requestContext(
  message: Message,
  taskId = "t1",
  contextId = "c1",
  task?: Task,
): RequestContext {
  const request: SendMessageRequest = {
    tenant: "test",
    message,
    configuration: undefined,
    metadata: undefined,
  };
  return new RequestContext(request, taskId, contextId, TEST_CALL_CONTEXT, task);
}

export function fakeTaskStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    load: async () => undefined,
    save: async () => {},
    list: async () => ({ tasks: [], nextPageToken: "", pageSize: 50, totalSize: 0 }),
    ...overrides,
  };
}

export function statusEvent(events: AgentExecutionEvent[]) {
  const event = events.findLast((candidate) => candidate.kind === "statusUpdate");
  return event?.kind === "statusUpdate" ? event.data : undefined;
}

export function artifactEvents(events: AgentExecutionEvent[]) {
  return events
    .filter((event): event is Extract<AgentExecutionEvent, { kind: "artifactUpdate" }> =>
      event.kind === "artifactUpdate"
    )
    .map((event) => event.data);
}

export function cardFixture(streaming: boolean, url: string): AgentCard {
  return {
    name: "Remote",
    description: "A remote agent",
    supportedInterfaces: [
      { url, protocolBinding: "JSONRPC", tenant: "", protocolVersion: A2A_PROTOCOL_VERSION },
    ],
    provider: undefined,
    version: "1.0.0",
    capabilities: { streaming, pushNotifications: false, extensions: [] },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [],
    signatures: [],
  };
}

export { artifact, Role, TaskState, taskStatus, textPart };
