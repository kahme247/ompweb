import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes, randomUUID } from "crypto";
import { createRequire } from "module";
const { createJiti } = createRequire(import.meta.url)("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { parseHostId, parseRemoteSessionId, parseWorkspaceId, makeRemoteSessionId } = jiti("./types.ts");
const { PlacementStore } = jiti("./placements.ts");
const { WorkerAuthenticator } = jiti("./worker-auth.ts");
const { WorkerSessionManager, assertWorkspacePrincipalIsolation } = jiti("./worker-sessions.ts");
const { sanitizeSafeAgentEvent, sanitizeSafeWebState } = jiti("./types.ts");
const { createWorkerServer } = jiti("./worker-server.ts");
const { curateOmpChildEnvironment } = jiti("../omp/rpc-process.ts");
const { WorkerRegistry, WorkerClient } = jiti("./worker-client.ts");
class FakeTransport {
  writes=[]; listeners=new Set(); disposed=0;
  async waitReady(){}
  async sendCommand(command){this.writes.push(command);for(const listener of this.listeners){listener({type:"agent_start"});listener({type:"message_update",message:{role:"assistant",content:[]}});listener({type:"agent_end"});}return {accepted:true};}
  onFrame(listener){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
  async dispose(){this.disposed++;}
}
function signed(auth,method,path,body,operationId,nonce=randomBytes(16).toString("hex")){const timestamp=String(Date.now());return {"content-type":"application/json","x-omp-audience":"golden","x-omp-timestamp":timestamp,"x-omp-nonce":nonce,"x-omp-operation-id":operationId,"x-omp-signature":auth.sign(method,path,body,timestamp,nonce,operationId)};}

test("validated IDs, atomic placements, and curated child environment",async()=>{assert.throws(()=>parseHostId("Bad"));assert.throws(()=>parseWorkspaceId("../root"));assert.throws(()=>parseRemoteSessionId("w:golden:not-a-uuid"));const dir=await mkdtemp(join(tmpdir(),"porbs-"));const host=parseHostId("golden"),id=makeRemoteSessionId(host);const store=new PlacementStore(join(dir,"placements.json"));await store.createPending(id,host,"main");const reopened=new PlacementStore(join(dir,"placements.json"));assert.equal((await reopened.get(id)).sessionId,id);const raw=await readFile(join(dir,"placements.json"),"utf8");for(const forbidden of ["origin","secret","sessionFile","pid"])assert.equal(raw.includes(forbidden),false);const env=curateOmpChildEnvironment({PATH:"/bin",PORBS_WORKER_SECRET:"x",PORBS_TOKEN:"y",OMP_WEB_PASSWORD:"z"});assert.deepEqual(env,{PATH:"/bin"});});

test("authenticated closed protocol, durable idempotency, and cursor reset",async(t)=>{const dir=await mkdtemp(join(tmpdir(),"porbs-")),workspace=await mkdtemp(join(tmpdir(),"porbs-ws-"));const host=parseHostId("golden"),secret="s".repeat(32),auth=new WorkerAuthenticator({hostId:host,secret,noncePath:join(dir,"nonces.json")});const fake=new FakeTransport();const operationPath=join(dir,"operations.json");let manager=new WorkerSessionManager({hostId:host,workspaces:{main:workspace},operationPath,spawnRpc:()=>fake});let server=createWorkerServer({auth,manager});await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));t.after(()=>server.close());const port=server.address().port,id=makeRemoteSessionId(host),createOp=randomUUID(),createPath=`/v1/sessions/${encodeURIComponent(id)}`,createBody=Buffer.from(JSON.stringify({v:1,operationId:createOp,workspaceId:"main"}));let response=await fetch(`http://127.0.0.1:${port}${createPath}`,{method:"PUT",headers:signed(auth,"PUT",createPath,createBody,createOp),body:createBody});const createText=await response.text();assert.equal(response.status,201,createText);const created=JSON.parse(createText);assert.equal(created.session.lifecycle,"ready");response=await fetch(`http://127.0.0.1:${port}${createPath}`,{method:"PUT",headers:{"content-type":"application/json"},body:createBody});assert.equal(response.status,401);
 const badOp=randomUUID(),badPath=`${createPath}/commands`,badBody=Buffer.from(JSON.stringify({v:1,operationId:badOp,expectedRevision:2,command:{type:"shell",command:"id"}}));response=await fetch(`http://127.0.0.1:${port}${badPath}`,{method:"POST",headers:signed(auth,"POST",badPath,badBody,badOp),body:badBody});assert.equal(response.status,400);assert.equal(fake.writes.length,0);
 const op=randomUUID(),command={v:1,operationId:op,expectedRevision:2,command:{type:"prompt",message:"hello"}},body=Buffer.from(JSON.stringify(command));response=await fetch(`http://127.0.0.1:${port}${badPath}`,{method:"POST",headers:signed(auth,"POST",badPath,body,op),body});assert.equal(response.status,200);const original=manager;assert.equal(fake.writes.length,1);manager=new WorkerSessionManager({hostId:host,workspaces:{main:workspace},operationPath,spawnRpc:()=>fake});const retried=await manager.command(id,op,2,{type:"prompt",message:"hello"});assert.equal(retried.result.accepted,true);assert.equal(fake.writes.length,1);
 const replay=original.events(id,"wrong-stream",0);assert.equal(replay.reset,true);const resumed=original.events(id,original.get(id).projection.streamId,1);assert.ok(resumed.records.every(record=>record.seq>1));});

test("production registry and event transport fail closed",async()=>{const old=process.env.NODE_ENV;process.env.NODE_ENV="production";try{assert.throws(()=>WorkerRegistry.fromEnvironment(JSON.stringify([{hostId:"golden",origin:"https://attacker.example",secret:"s".repeat(32),exedevToken:"token"}])),/invalid worker origin/);const registry=WorkerRegistry.fromEnvironment(JSON.stringify([{hostId:"golden",origin:"https://worker.exe.xyz",secret:"s".repeat(32),exedevToken:"token"}]));assert.ok(registry.first());}finally{process.env.NODE_ENV=old;}let captured;const client=new WorkerClient({hostId:parseHostId("golden"),origin:"http://127.0.0.1:1",secret:"s".repeat(32),workspaceId:"main"},async(_url,init)=>{captured=init;return new Response(null,{status:200,headers:{"content-type":"text/event-stream"}});});const abort=new AbortController();await client.events(makeRemoteSessionId(parseHostId("golden")),null,0,abort.signal);assert.equal(captured.signal,abort.signal);});


test("event schemas strip private paths and reject unknown types",()=>{const safe=sanitizeSafeAgentEvent({type:"message_update",message:{role:"assistant",content:[],sessionFile:"/secret/session.jsonl"}});assert.equal(JSON.stringify(safe).includes("/secret"),false);assert.throws(()=>sanitizeSafeAgentEvent({type:"arbitrary",sessionFile:"/secret"}),/invalid_worker_event/);assert.throws(()=>sanitizeSafeAgentEvent({type:"agent_end",isTerminal:"false"}),/invalid_worker_event/);});
test("workspace isolation rejects a session-writable root",async()=>{const root=await mkdtemp(join(tmpdir(),"porbs-perms-"));await assert.rejects(()=>assertWorkspacePrincipalIsolation(root,{main:root},process.getuid(),process.getgid()),/session principal writes/);});

test("state projection is closed and event values are shape checked",()=>{const state=sanitizeSafeWebState({sessionId:"s",nested:{sessionFile:"/secret"},workspacePath:"/private",isStreaming:false});assert.deepEqual(state,{sessionId:"s",isStreaming:false});assert.throws(()=>sanitizeSafeAgentEvent({type:"notice",level:7,message:{}}),/invalid_worker_event/);});

test("pinned workspace replacement fails before spawn",async()=>{const root=await mkdtemp(join(tmpdir(),"porbs-pin-")),host=parseHostId("golden"),id=makeRemoteSessionId(host);let spawns=0;const manager=new WorkerSessionManager({hostId:host,workspaces:{main:root},workspaceRoot:root,workspaceIdentities:{[root]:{dev:-1,ino:-1}},operationPath:join(root,"ops.json"),spawnRpc:()=>{spawns++;return new FakeTransport();}});await assert.rejects(()=>manager.create(id,"main",randomUUID()),/unknown_workspace/);assert.equal(spawns,0);});
