"use client";

import dynamic from "@/lib/dynamic";
import { useEffect, useState } from "react";
import type { SessionInfo } from "@/lib/types";

const CommandPalette = dynamic(() => import("./CommandPalette").then((module) => module.CommandPalette));

type Props = {
  onSelectSession: (session: SessionInfo) => void;
  onNewSession: () => void;
  currentModel?: string | null;
};

/**
 * Keeps the command palette chunk out of the initial shell. The first
 * Ctrl/Cmd+K or explicit toolbar action mounts it with the palette already
 * open; subsequent shortcuts are handled by the palette itself.
 */
export function CommandPaletteMount(props: Props) {
  const [loaded, setLoaded] = useState(false);
  const [openRequest, setOpenRequest] = useState(0);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (!loaded) {
          setLoaded(true);
          setOpenRequest((request) => request + 1);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [loaded]);

  useEffect(() => {
    const onOpenRequest = () => {
      setLoaded(true);
      setOpenRequest((request) => request + 1);
    };
    window.addEventListener("omp:open-command-palette", onOpenRequest);
    return () => window.removeEventListener("omp:open-command-palette", onOpenRequest);
  }, []);

  if (!loaded) return null;
  return <CommandPalette {...props} initialOpen={openRequest > 0} openRequest={openRequest} />;
}
