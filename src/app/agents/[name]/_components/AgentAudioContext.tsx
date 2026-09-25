"use client";

import { createContext, useContext } from "react";

export const AgentAudioContext = createContext<{ enabled?: boolean; error?: string }>({});
export function useAgentAudio() { return useContext(AgentAudioContext); }
