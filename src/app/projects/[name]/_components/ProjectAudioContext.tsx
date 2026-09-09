"use client";

import { createContext, useContext } from "react";

export const ProjectAudioContext = createContext<{ enabled?: boolean; error?: string }>({});
export function useProjectAudio() { return useContext(ProjectAudioContext); }
