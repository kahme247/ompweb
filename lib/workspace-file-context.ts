import { createContext } from "react";
import type { WorkspaceFileSource } from "./workspace-types";

export const WorkspaceFileContext = createContext<WorkspaceFileSource | null>(null);
