"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { SidebarTab } from "./ChatSidebarItems";

type RouteSelection = { chatId: string; tab: SidebarTab };
const Context = createContext<{
  route: RouteSelection | null;
  setRoute: React.Dispatch<React.SetStateAction<RouteSelection | null>>;
} | null>(null);

export function ChatRouteProvider({ children }: { children: React.ReactNode }) {
  const [route, setRoute] = useState<RouteSelection | null>(null);
  const value = useMemo(() => ({ route, setRoute }), [route]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useChatRouteSelection() {
  const context = useContext(Context);
  if (!context) throw new Error("ChatRouteProvider is required");
  return context;
}

/** The route's verified Workspace lookup owns conversation type, independently of sidebar pagination. */
export function ChatRouteSelection({ chatId, tab }: RouteSelection) {
  const { setRoute } = useChatRouteSelection();
  useEffect(() => {
    setRoute({ chatId, tab });
    return () => setRoute(current => current?.chatId === chatId ? null : current);
  }, [chatId, tab, setRoute]);
  return null;
}
