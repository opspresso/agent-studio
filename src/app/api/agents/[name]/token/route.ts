import { apiTokenUseCases } from "@/lib/container";
import { createCredentialRoutes } from "@/app/api/agents/_lib/credentialRoutes";
const routes = createCredentialRoutes(apiTokenUseCases);
export const GET = routes.GET;
export const POST = routes.POST;
export const DELETE = routes.DELETE;
