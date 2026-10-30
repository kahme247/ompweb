// The API route table: one entry per app/api/**/route.ts (server/routes.test.ts fails when they differ).
// Static imports, not a runtime glob, so a future `bun build --compile` can bundle every handler.
import * as agentIdBashOutput from "@/app/api/agent/[id]/bash-output/route";
import * as agentId from "@/app/api/agent/[id]/route";
import * as agentNew from "@/app/api/agent/new/route";
import * as agents from "@/app/api/agents/route";
import * as appUpdateNotes from "@/app/api/app-update/notes/route";
import * as appUpdate from "@/app/api/app-update/route";
import * as authAccountsProvider from "@/app/api/auth/accounts/[provider]/route";
import * as authAllProviders from "@/app/api/auth/all-providers/route";
import * as authApiKeyProvider from "@/app/api/auth/api-key/[provider]/route";
import * as authLoginProvider from "@/app/api/auth/login/[provider]/route";
import * as authProviders from "@/app/api/auth/providers/route";
import * as cwdBrowse from "@/app/api/cwd/browse/route";
import * as cwdValidate from "@/app/api/cwd/validate/route";
import * as defaultCwd from "@/app/api/default-cwd/route";
import * as events from "@/app/api/events/route";
import * as fileIndex from "@/app/api/file-index/route";
import * as filesPath from "@/app/api/files/[...path]/route";
import * as gitDiff from "@/app/api/git/diff/route";
import * as gitStatus from "@/app/api/git/status/route";
import * as githubRepo from "@/app/api/github-repo/route";
import * as home from "@/app/api/home/route";
import * as hostsLinkBlobReqId from "@/app/api/hosts/link/blob/[reqId]/route";
import * as hostsLink from "@/app/api/hosts/link/route";
import * as hosts from "@/app/api/hosts/route";
import * as manifest from "@/app/api/manifest/route";
import * as mcp from "@/app/api/mcp/route";
import * as mediaHash from "@/app/api/media/[hash]/route";
import * as modelRoles from "@/app/api/model-roles/route";
import * as modelsConfigCatalog from "@/app/api/models-config/catalog/route";
import * as modelsConfig from "@/app/api/models-config/route";
import * as modelsConfigTest from "@/app/api/models-config/test/route";
import * as models from "@/app/api/models/route";
import * as notificationsDevices from "@/app/api/notifications/devices/route";
import * as notificationsHistory from "@/app/api/notifications/history/route";
import * as notificationsPresence from "@/app/api/notifications/presence/route";
import * as notificationsTest from "@/app/api/notifications/test/route";
import * as ompSettings from "@/app/api/omp-settings/route";
import * as ompUpdate from "@/app/api/omp-update/route";
import * as ompVersion from "@/app/api/omp-version/route";
import * as plugins from "@/app/api/plugins/route";
import * as projectsClone from "@/app/api/projects/clone/route";
import * as projects from "@/app/api/projects/route";
import * as providerUsage from "@/app/api/provider-usage/route";
import * as providersEnable from "@/app/api/providers/enable/route";
import * as sessionsIdArchive from "@/app/api/sessions/[id]/archive/route";
import * as sessionsIdAutoName from "@/app/api/sessions/[id]/auto-name/route";
import * as sessionsIdContext from "@/app/api/sessions/[id]/context/route";
import * as sessionsIdEntriesEntryIdThinking from "@/app/api/sessions/[id]/entries/[entryId]/thinking/route";
import * as sessionsIdExport from "@/app/api/sessions/[id]/export/route";
import * as sessionsId from "@/app/api/sessions/[id]/route";
import * as sessionsIdState from "@/app/api/sessions/[id]/state/route";
import * as sessionsIdSubagentsSubagentId from "@/app/api/sessions/[id]/subagents/[subagentId]/route";
import * as sessionsIdSubagents from "@/app/api/sessions/[id]/subagents/route";
import * as sessionsArchive from "@/app/api/sessions/archive/route";
import * as sessionsImport from "@/app/api/sessions/import/route";
import * as sessions from "@/app/api/sessions/route";
import * as sessionsSearch from "@/app/api/sessions/search/route";
import * as skillsCheck from "@/app/api/skills/check/route";
import * as skillsInstall from "@/app/api/skills/install/route";
import * as skills from "@/app/api/skills/route";
import * as skillsSearch from "@/app/api/skills/search/route";
import * as skillsUpdate from "@/app/api/skills/update/route";
import * as sttJobIdAudio from "@/app/api/stt/[jobId]/audio/route";
import * as sttJobId from "@/app/api/stt/[jobId]/route";
import * as stt from "@/app/api/stt/route";
import * as usage from "@/app/api/usage/route";
import * as webAuthSession from "@/app/api/web-auth/session/route";
import * as webSettings from "@/app/api/web-settings/route";
import * as windowsService from "@/app/api/windows-service/route";
import * as worktrees from "@/app/api/worktrees/route";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
// never: each handler narrows its own params; the router passes Record<string, string | string[]>.
// disableIdleTimeout: for a gate-exempt route that authenticates itself (the host link) and then stays open.
export type RouteHandler = (
  request: Request,
  context: { params: Promise<never>; disableIdleTimeout: () => void },
) => Response | Promise<Response>;
export type RouteModule = Partial<Record<Method, RouteHandler>>;

// Key: the route's directory under app/api.
export const ROUTE_MODULES: Record<string, RouteModule> = {
  "agent/[id]/bash-output": agentIdBashOutput,
  "agent/[id]": agentId,
  "agent/new": agentNew,
  "agents": agents,
  "app-update/notes": appUpdateNotes,
  "app-update": appUpdate,
  "auth/accounts/[provider]": authAccountsProvider,
  "auth/all-providers": authAllProviders,
  "auth/api-key/[provider]": authApiKeyProvider,
  "auth/login/[provider]": authLoginProvider,
  "auth/providers": authProviders,
  "cwd/browse": cwdBrowse,
  "cwd/validate": cwdValidate,
  "default-cwd": defaultCwd,
  "events": events,
  "file-index": fileIndex,
  "files/[...path]": filesPath,
  "git/diff": gitDiff,
  "git/status": gitStatus,
  "github-repo": githubRepo,
  "home": home,
  "hosts/link/blob/[reqId]": hostsLinkBlobReqId,
  "hosts/link": hostsLink,
  "hosts": hosts,
  "manifest": manifest,
  "mcp": mcp,
  "media/[hash]": mediaHash,
  "model-roles": modelRoles,
  "models-config/catalog": modelsConfigCatalog,
  "models-config": modelsConfig,
  "models-config/test": modelsConfigTest,
  "models": models,
  "notifications/devices": notificationsDevices,
  "notifications/history": notificationsHistory,
  "notifications/presence": notificationsPresence,
  "notifications/test": notificationsTest,
  "omp-settings": ompSettings,
  "omp-update": ompUpdate,
  "omp-version": ompVersion,
  "plugins": plugins,
  "projects/clone": projectsClone,
  "projects": projects,
  "provider-usage": providerUsage,
  "providers/enable": providersEnable,
  "sessions/[id]/archive": sessionsIdArchive,
  "sessions/[id]/auto-name": sessionsIdAutoName,
  "sessions/[id]/context": sessionsIdContext,
  "sessions/[id]/entries/[entryId]/thinking": sessionsIdEntriesEntryIdThinking,
  "sessions/[id]/export": sessionsIdExport,
  "sessions/[id]": sessionsId,
  "sessions/[id]/state": sessionsIdState,
  "sessions/[id]/subagents/[subagentId]": sessionsIdSubagentsSubagentId,
  "sessions/[id]/subagents": sessionsIdSubagents,
  "sessions/archive": sessionsArchive,
  "sessions/import": sessionsImport,
  "sessions": sessions,
  "sessions/search": sessionsSearch,
  "skills/check": skillsCheck,
  "skills/install": skillsInstall,
  "skills": skills,
  "skills/search": skillsSearch,
  "skills/update": skillsUpdate,
  "stt/[jobId]/audio": sttJobIdAudio,
  "stt/[jobId]": sttJobId,
  "stt": stt,
  "usage": usage,
  "web-auth/session": webAuthSession,
  "web-settings": webSettings,
  "windows-service": windowsService,
  "worktrees": worktrees,
};

const METHODS: Method[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** Bun.serve pattern for a table key: `[x]` → `:x`, `[...x]` → `*` (its segments start at pathname index `rest.index`). */
export function routePattern(key: string): { pattern: string; rest: { name: string; index: number } | null } {
  const segments = key.split("/");
  const restAt = segments.findIndex((segment) => segment.startsWith("[..."));
  const pattern = `/api/${segments.map((segment) => (segment.startsWith("[...") ? "*" : segment.replace(/^\[(\w+)\]$/, ":$1"))).join("/")}`;
  // pathname.split("/") is ["", "api", ...segments].
  return { pattern, rest: restAt < 0 ? null : { name: segments[restAt].slice(4, -1), index: restAt + 2 } };
}

/** Runs the module's handler for the request method, answering HEAD, OPTIONS and missing methods as Next did. */
export async function dispatch(
  mod: RouteModule,
  request: Request,
  params: Record<string, string | string[]>,
  disableIdleTimeout: () => void = () => {},
): Promise<Response> {
  const handler = mod[request.method as Method] ?? (request.method === "HEAD" ? mod.GET : undefined);
  if (!handler) {
    const methods = METHODS.filter((method) => mod[method]);
    if (request.method !== "OPTIONS") return new Response(null, { status: 405, headers: { allow: methods.join(", ") } });
    const allow = [...methods, ...(mod.GET ? ["HEAD"] : []), "OPTIONS"].sort().join(", ");
    return new Response(null, { status: 204, headers: { allow } });
  }
  try {
    return await handler(request, { params: Promise.resolve(params) as Promise<never>, disableIdleTimeout });
  } catch (error) {
    console.error(error);
    return Response.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
