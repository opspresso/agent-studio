import { webhookTokenUseCases } from "@/lib/container";
import { createCredentialRoutes } from "@/app/api/agents/_lib/credentialRoutes";
const routes = createCredentialRoutes(webhookTokenUseCases);
export const GET = routes.GET;
export const POST = routes.POST;
export const DELETE = routes.DELETE;
