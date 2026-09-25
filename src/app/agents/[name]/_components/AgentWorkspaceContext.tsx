"use client";

import { createContext, useContext } from "react";

export const AgentWorkspaceContext = createContext<{ enabled?: boolean; error?: string }>({});
export function useAgentWorkspace() { return useContext(AgentWorkspaceContext); }
