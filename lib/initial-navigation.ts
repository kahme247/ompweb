export interface InitialNavigation {
  requestedCwd: string | null;
  sessionId: string | null;
  hostId?: string;
  poolId?: string;
  projectId?: string;
  creationId?: string;
}

export function getInitialNavigation(searchParams: Pick<URLSearchParams, "get">): InitialNavigation {
  const requestedCwd = searchParams.get("cwd")?.trim() || null;
  const poolId = searchParams.get("poolId") || undefined;
  const projectId = searchParams.get("projectId") || undefined;
  if (poolId || projectId) return {
    requestedCwd: null, sessionId: null, poolId, projectId,
    creationId: searchParams.get("creationId") || undefined,
  };

  return {
    requestedCwd,
    sessionId: requestedCwd ? null : searchParams.get("session"),
    ...(requestedCwd && searchParams.get("hostId") !== null ? { hostId: searchParams.get("hostId")! } : {}),
  };
}

export function readCreationInitialization(creationId: string): string | undefined {
  try {
    return window.sessionStorage.getItem(`omp-creation:${creationId}`) ?? undefined;
  } catch {
    return undefined;
  }
}

/** A durable creation ID always reuses its first native initialization, not current composer preferences. */
export function rememberCreationInitialization(creationId: string, initialization: string): string {
  const retained = readCreationInitialization(creationId);
  if (retained !== undefined) return retained;
  try {
    window.sessionStorage.setItem(`omp-creation:${creationId}`, initialization);
  } catch { /* The current composer still retains its frozen initialization. */ }
  return initialization;
}
