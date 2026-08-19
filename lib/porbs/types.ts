import { randomUUID } from "crypto";

export type HostId = string & { readonly __hostId: unique symbol };
export type RemoteSessionId = string & { readonly __remoteSessionId: unique symbol };

const HOST_RE = /^[a-z][a-z0-9-]{0,31}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WORKSPACE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function parseHostId(value: unknown): HostId {
  if (typeof value !== "string" || !HOST_RE.test(value)) throw new Error("invalid_host_id");
  return value as HostId;
}
export function parseWorkspaceId(value: unknown): string {
  if (typeof value !== "string" || !WORKSPACE_RE.test(value)) throw new Error("invalid_workspace_id");
  return value;
}
export function makeRemoteSessionId(hostId: HostId, uuid: string = randomUUID()): RemoteSessionId {
  if (!UUID_RE.test(uuid)) throw new Error("invalid_session_uuid");
  return `w:${hostId}:${uuid}` as RemoteSessionId;
}
export function parseRemoteSessionId(value: unknown): { id: RemoteSessionId; hostId: HostId; uuid: string } {
  if (typeof value !== "string") throw new Error("invalid_remote_session_id");
  const parts = value.split(":");
  if (parts.length !== 3 || parts[0] !== "w" || !UUID_RE.test(parts[2])) throw new Error("invalid_remote_session_id");
  return { id: value as RemoteSessionId, hostId: parseHostId(parts[1]), uuid: parts[2] };
}

export interface SessionPlacement {
  version: 1; sessionId: RemoteSessionId; hostId: HostId; workspaceId: string;
  lifecycle: "creating" | "active" | "stopping" | "stopped" | "failed";
  revision: number; createdAt: string; updatedAt: string;
}
export interface WorkerSession {
  version: 1; sessionId: RemoteSessionId;
  lifecycle: "starting" | "ready" | "running" | "stopping" | "stopped" | "failed";
  revision: number; streamId: string; lastSeq: number; createdAt: string; updatedAt: string;
  exit?: { kind: "exit" | "signal" | "error"; code?: number; signal?: string };
}
export type WorkerCommand = { type: "prompt"; message: string } | { type: "abort" };
export type SafeEventType = "connected"|"agent_start"|"agent_end"|"message_start"|"message_update"|"message_end"|"notice";
type SafeEventField = "sessionId"|"message"|"level"|"reason"|"isTerminal"|"result"|"error"|"reset";
export type SafeAgentEvent = {type:SafeEventType}&Partial<Record<SafeEventField,unknown>>;
const SAFE_EVENT_FIELDS:Record<SafeEventType,readonly SafeEventField[]>={
  connected:["sessionId","reset"],agent_start:[],agent_end:["reason","isTerminal","result","error"],message_start:["message"],message_update:["message"],message_end:["message"],notice:["level","message"],
};
const SAFE_STATE_FIELDS=["sessionId","sessionName","isStreaming","isPromptRunning","isBashRunning","isCompacting","autoCompactionEnabled","interruptMode","steeringMode","followUpMode","model","messageCount","queuedMessageCount","contextUsage","systemPrompt","thinkingLevel","fastModeEnabled","fastModeActive","autoRetryEnabled","todoPhases","extensionStatuses","extensionWidgets"] as const;
export function sanitizeSafeWebState(value:unknown):Record<string,unknown>{if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("invalid_worker_state");const source=value as Record<string,unknown>,clean:Record<string,unknown>={};for(const key of SAFE_STATE_FIELDS)if(key in source)clean[key]=sanitizeStateValue(source[key]);return clean;}
function sanitizeStateValue(value:unknown):unknown{if(value===null||["string","number","boolean"].includes(typeof value))return value;if(Array.isArray(value))return value.slice(0,1000).map(sanitizeStateValue);if(value&&typeof value==="object"){const clean:Record<string,unknown>={};for(const [key,nested]of Object.entries(value)){if(["sessionFile","sessionPath","cwd","fullOutputPath","pid","workspacePath","homeDirectory"].includes(key))continue;clean[key]=sanitizeStateValue(nested);}return clean;}throw new Error("invalid_worker_state");}
export function sanitizeSafeAgentEvent(value:unknown):SafeAgentEvent{if(!value||typeof value!=="object"||Array.isArray(value)||!("type"in value)||typeof value.type!=="string"||!(value.type in SAFE_EVENT_FIELDS))throw new Error("invalid_worker_event");const type=value.type as SafeEventType,source=value as Record<string,unknown>,event:Record<string,unknown>={type};for(const key of SAFE_EVENT_FIELDS[type])if(key in source)event[key]=sanitizeStateValue(source[key]);validateEventShape(type,event);return event as SafeAgentEvent;}
function validateEventShape(type:SafeEventType,event:Record<string,unknown>){const optionalString=(key:string)=>!(key in event)||typeof event[key]==="string";if(type==="connected"&&(typeof event.sessionId!=="string"||"reset"in event&&typeof event.reset!=="boolean")||type==="agent_end"&&("isTerminal"in event&&typeof event.isTerminal!=="boolean"||!optionalString("reason")||!optionalString("error")||"result"in event&&(event.result===null||typeof event.result!=="object"))||type==="notice"&&(typeof event.level!=="string"||typeof event.message!=="string")||["message_start","message_update","message_end"].includes(type)&&(!event.message||typeof event.message!=="object"))throw new Error("invalid_worker_event");}
export interface EventRecord { v: 1; sessionId: RemoteSessionId; streamId: string; seq: number; event: SafeAgentEvent }
