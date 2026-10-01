import { webhookTokenUseCases } from "@/lib/container";
import { createCredentialRoutes } from "@/app/api/agents/_lib/credentialRoutes";
export const POST = createCredentialRoutes(webhookTokenUseCases).REVEAL;
