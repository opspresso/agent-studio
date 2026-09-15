"use client";

import { createContext, useContext } from "react";

export const ProjectWorkspaceContext = createContext<{ enabled?: boolean; error?: string }>({});
export function useProjectWorkspace() { return useContext(ProjectWorkspaceContext); }
