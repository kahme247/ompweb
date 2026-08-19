import { randomUUID, createHash } from "crypto";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "fs/promises";
import { dirname, sep } from "path";
import { RpcProcess, type RpcFrame } from "../omp/rpc-process";
import { parseRemoteSessionId, parseWorkspaceId, sanitizeSafeAgentEvent, sanitizeSafeWebState, type EventRecord, type RemoteSessionId, type WorkerCommand, type WorkerSession } from "./types";

export interface OmpTransport { waitReady(): Promise<unknown>; sendCommand<T=unknown>(command: Record<string, unknown>): Promise<T>; onFrame(listener:(frame: RpcFrame)=>void):()=>void; dispose():Promise<void> }
export type SpawnRpc = (options: { sessionId: RemoteSessionId; canonicalCwd: string; childEnv: Record<string,string> }) => OmpTransport;
interface Internal { projection: WorkerSession; transport?: OmpTransport; events: EventRecord[]; bytes: number; listeners: Set<(event: EventRecord)=>void> }
interface Operation { digest: string; status: "started"|"completed"; result?: unknown }
export interface WorkspaceIdentity{dev:number;ino:number}
export async function assertWorkspacePrincipalIsolation(rootPath:string,workspaces:Record<string,string>,uid:number,gid:number):Promise<Record<string,WorkspaceIdentity>>{
  const root=await realpath(rootPath),boundary=dirname(root),paths=new Set<string>([boundary,root]);
  for(const value of Object.values(workspaces)){
    let current=await realpath(value);
    if(current!==root&&!current.startsWith(root+sep))throw new Error("workspace outside root");
    for(;;){paths.add(current);if(current===root)break;current=dirname(current);}
  }
  const identities:Record<string,WorkspaceIdentity>={};
  for(const canonical of paths){const info=await stat(canonical),writable=info.uid===uid&&(info.mode&0o200)!==0||info.gid===gid&&(info.mode&0o020)!==0||(info.mode&0o002)!==0;if(!info.isDirectory()||writable)throw new Error("workspace permissions allow session principal writes");identities[canonical]={dev:info.dev,ino:info.ino};}
  return identities;
}

export class WorkerSessionManager {
  private sessions = new Map<RemoteSessionId, Internal>(); private operations = new Map<string, Operation>(); private loaded = false; private queue = Promise.resolve();
  private options: { hostId: string; workspaces: Record<string,string>; workspaceRoot?:string; workspaceIdentities?:Record<string,WorkspaceIdentity>; operationPath: string; spawnRpc?: SpawnRpc; uid?:number; gid?:number };
  constructor(options: { hostId: string; workspaces: Record<string,string>; workspaceRoot?:string; workspaceIdentities?:Record<string,WorkspaceIdentity>; operationPath: string; spawnRpc?: SpawnRpc; uid?:number; gid?:number }) { this.options = options; }
  private async load() { if (this.loaded) return; try { const parsed = JSON.parse(await readFile(this.options.operationPath,"utf8")) as { operations:[string,Operation][] }; this.operations = new Map(parsed.operations); } catch(e) { if ((e as NodeJS.ErrnoException).code!=="ENOENT") throw e; } this.loaded=true; }
  private async persist() { await mkdir(dirname(this.options.operationPath),{recursive:true,mode:0o700}); const tmp=`${this.options.operationPath}.${process.pid}.tmp`; await writeFile(tmp,JSON.stringify({version:1,operations:[...this.operations]}),{mode:0o600}); await rename(tmp,this.options.operationPath); }
  private async operation<T>(key:string,digest:string,sideEffect:()=>Promise<T>):Promise<T> {
    const reservation=this.queue.then(async()=>{await this.load();const prior=this.operations.get(key);if(prior){if(prior.digest!==digest)throw new Error("operation_conflict");if(prior.status==="completed")return {prior:prior.result as T};throw new Error("operation_indeterminate");}this.operations.set(key,{digest,status:"started"});await this.persist();return {prior:undefined};});
    this.queue=reservation.then(()=>undefined,()=>undefined);
    const reserved=await reservation;
    if(reserved.prior!==undefined)return reserved.prior;
    const result=await sideEffect();
    const completion=this.queue.then(async()=>{this.operations.set(key,{digest,status:"completed",result});await this.persist();});
    this.queue=completion.then(()=>undefined,()=>undefined);
    await completion;
    return result;
  }
  private emit(internal:Internal,event:RpcFrame) { let safe;try{safe=sanitizeSafeAgentEvent(event);}catch{return;}const encoded=JSON.stringify(safe);if(Buffer.byteLength(encoded)>256*1024)return;const p=internal.projection;const record:EventRecord={v:1,sessionId:p.sessionId,streamId:p.streamId,seq:++p.lastSeq,event:safe};internal.events.push(record);internal.bytes+=Buffer.byteLength(JSON.stringify(record));while(internal.events.length>512||internal.bytes>2*1024*1024){const old=internal.events.shift();if(old)internal.bytes-=Buffer.byteLength(JSON.stringify(old));}for(const listener of internal.listeners)listener(record);}
  async create(sessionId:RemoteSessionId, workspaceValue:string, operationId:string) { const {hostId}=parseRemoteSessionId(sessionId); if(hostId!==this.options.hostId)throw new Error("wrong_host"); const workspaceId=parseWorkspaceId(workspaceValue); const configured=this.options.workspaces[workspaceId]; if(!configured)throw new Error("unknown_workspace"); const digest=createHash("sha256").update(JSON.stringify({sessionId,workspaceId})).digest("hex"); return this.operation(`create:${operationId}`,digest,async()=>{ const existing=this.sessions.get(sessionId); if(existing)return existing.projection; let canonical:string,root:string;try{canonical=await realpath(configured);root=await realpath(this.options.workspaceRoot??dirname(configured));}catch{throw new Error("unknown_workspace");}const canonicalInfo=await stat(canonical),rootInfo=await stat(root),pinned=this.options.workspaceIdentities;if(!canonicalInfo.isDirectory()||canonical!==root&&!canonical.startsWith(root+sep)||pinned&&(pinned[canonical]?.dev!==canonicalInfo.dev||pinned[canonical]?.ino!==canonicalInfo.ino||pinned[root]?.dev!==rootInfo.dev||pinned[root]?.ino!==rootInfo.ino))throw new Error("unknown_workspace"); const now=new Date().toISOString(); const projection:WorkerSession={version:1,sessionId,lifecycle:"starting",revision:1,streamId:randomUUID(),lastSeq:0,createdAt:now,updatedAt:now}; const internal:Internal={projection,events:[],bytes:0,listeners:new Set()}; this.sessions.set(sessionId,internal); if(pinned)for(const [path,identity]of Object.entries(pinned)){const current=await stat(path);if(current.dev!==identity.dev||current.ino!==identity.ino)throw new Error("unknown_workspace");}const spawn=this.options.spawnRpc??(({canonicalCwd})=>new RpcProcess({cwd:canonicalCwd,env:{},uid:this.options.uid,gid:this.options.gid})); const transport=spawn({sessionId,canonicalCwd:canonical,childEnv:{}}); internal.transport=transport; transport.onFrame(frame=>this.emit(internal,frame)); await transport.waitReady(); projection.lifecycle="ready"; projection.revision++; projection.updatedAt=new Date().toISOString(); this.emit(internal,{type:"connected",sessionId}); return projection; }); }
  get(id:RemoteSessionId){return this.sessions.get(id);}
  async state(id:RemoteSessionId){const internal=this.sessions.get(id);if(!internal?.transport)throw new Error("session_not_found");const raw=await internal.transport.sendCommand<Record<string,unknown>>({type:"get_state"});return {projection:internal.projection,state:sanitizeSafeWebState(raw) as Record<string,unknown>};}
  async command(id:RemoteSessionId,operationId:string,expectedRevision:number,command:WorkerCommand){
    if(command.type==="prompt"&&(typeof command.message!=="string"||!command.message||command.message.length>1_000_000))throw new Error("invalid_command");
    const digest=createHash("sha256").update(JSON.stringify({id,expectedRevision,command})).digest("hex");
    return this.operation(`command:${operationId}`,digest,async()=>{
      const internal=this.sessions.get(id);
      if(!internal?.transport)throw new Error("session_not_found");
      if(expectedRevision!==internal.projection.revision)throw new Error("revision_conflict");
      internal.projection.revision++;
      const result=await internal.transport.sendCommand(command);
      return {v:1,operationId,result,session:internal.projection};
    });
  }
  events(id:RemoteSessionId,streamId:string|null,after:number){const internal=this.sessions.get(id);if(!internal)throw new Error("session_not_found");const reset=streamId!==null&&streamId!==""&&streamId!==internal.projection.streamId || after>internal.projection.lastSeq || (after>0&&internal.events.length>0&&after<internal.events[0].seq-1);return {internal,reset,records:reset?[]:internal.events.filter(e=>e.seq>after)};}
  async stop(id:RemoteSessionId,operationId:string,expectedRevision:number){const digest=createHash("sha256").update(JSON.stringify({id})).digest("hex");return this.operation(`stop:${operationId}`,digest,async()=>{const internal=this.sessions.get(id);if(!internal)throw new Error("session_not_found");if(internal.projection.revision!==expectedRevision)throw new Error("revision_conflict");internal.projection.lifecycle="stopping";await internal.transport?.dispose();internal.projection.lifecycle="stopped";internal.projection.revision++;return {v:1,operationId,session:internal.projection};});}
}
