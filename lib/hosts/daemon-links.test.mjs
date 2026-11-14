import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeLine, LINK_LIMITS, LINK_PROTOCOL_VERSION } from "./link-protocol.ts";

const scratch = mkdtempSync(join(tmpdir(), "daemon-links-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = scratch;
test.after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(scratch, { recursive: true, force: true });
});
const { DaemonLink } = await import("./daemon-link.ts");

const until = async predicate => { const end=Date.now()+5000;while(!predicate()){if(Date.now()>end)throw Error("link timeout");await new Promise(r=>setTimeout(r,10));} };
function hub(t, max=LINK_PROTOCOL_VERSION){
  const hellos=[],messages=[];let socket,ack=0;
  const server=Bun.serve({port:0,hostname:"127.0.0.1",fetch(req,s){return s.upgrade(req)?undefined:new Response("",{status:426});},websocket:{message(ws,data){if(typeof data!=="string")return;for(const line of data.split("\n").filter(Boolean)){const m=JSON.parse(line);if(m.type==="hello"){hellos.push(m);socket=ws;if(m.v>max){ws.close(4426,JSON.stringify({serverVersion:max}));continue;}ws.send(encodeLine({type:"welcome",v:max,hostId:"h"}));}else if(m.seq){messages.push(m);ack=m.seq;}}if(ws.readyState===1)ws.send(encodeLine({type:"ack",ack}));}}});t.after(()=>server.stop(true));
  return {url:`http://127.0.0.1:${server.port}`,hellos,messages,close:(code)=>socket.close(code),setMax:(version)=>{max=version;}};
}
function link(server,id,ends,options={}){return new DaemonLink({url:server.url,token:"test"},id,{allowHttp:false,primary:id==="l1",hello:(link)=>encodeLine({type:"hello",v:link.version,ompVersion:null,platform:"linux",home:"/tmp",autoApproveExtension:false,ack:link.ackedDown,channels:[],link:{id:link.id,notifier:false}}),handleDown(){},onEnd:(link,reason)=>ends.push([link.id,reason]),log(){},...options});}

test("a server below the minimum protocol ends only its own link and leaves the other live",async t=>{
  const a=hub(t),b=hub(t,LINK_PROTOCOL_VERSION-1),ends=[],la=link(a,"l1",ends),lb=link(b,"l2",ends);t.after(()=>Promise.all([la.stop(),lb.stop()]));la.start();lb.start();
  await until(()=>la.isUp()&&ends.length===1);assert.equal(a.hellos[0].link.id,"l1");assert.equal(b.hellos[0].link.id,"l2");assert.equal(b.hellos.at(-1).v,LINK_PROTOCOL_VERSION);
  assert.deepEqual(ends,[["l2","version"]]);assert.equal(lb.isUp(),false);assert.equal(la.isUp(),true);
  la.queue({type:"sessions_changed"},"sessions");await until(()=>a.messages.some(m=>m.type==="sessions_changed"));
});

test("overflow preserves numbered sequence records and resyncs only its own link",async t=>{
  const a=hub(t),b=hub(t),ends=[],la=link(a,"l1",ends),lb=link(b,"l2",ends);t.after(()=>Promise.all([la.stop(),lb.stop()]));la.start();lb.start();await until(()=>la.isUp()&&lb.isUp());
  const old=LINK_LIMITS.channelBufferBytes;LINK_LIMITS.channelBufferBytes=1000;t.after(()=>{LINK_LIMITS.channelBufferBytes=old;});
  la.output({type:"stdout",ch:"c",line:"x".repeat(2000)},"s");lb.output({type:"stdout",ch:"c",line:"ok"},"s");
  await until(()=>a.messages.some(m=>m.type==="resync")&&b.messages.some(m=>m.type==="stdout"));
  assert.equal(b.messages.some(m=>m.type==="resync"),false);assert.deepEqual(a.messages.map(m=>m.seq),a.messages.map((_,i)=>i+1));
});

test("token rotation keeps the logical link and leaves the other socket alone", async t => {
  const a = hub(t), b = hub(t), ends = [], la = link(a, "l1", ends), lb = link(b, "l2", ends);
  t.after(() => Promise.all([la.stop(), lb.stop()])); la.start(); lb.start();
  await until(() => la.isUp() && lb.isUp());
  la.rekey("new-token"); await until(() => a.hellos.length === 2);
  assert.equal(a.hellos[1].link.id, "l1"); assert.equal(b.hellos.length, 1); assert.deepEqual(ends, []);
});

test("a fresh snapshot discards old output without discarding its queued open result", async t => {
  const server = hub(t), connection = link(server, "l1", []);
  t.after(() => connection.stop()); connection.start(); await until(() => connection.isUp());
  connection.result("open", { ch: "c" }, { key: "c" });
  connection.output({ type: "stdout", ch: "c", line: "old delta" }, null);
  connection.discard("c");
  await until(() => server.messages.some(message => message.type === "res" && message.id === "open"));
  assert.equal(server.messages.some(message => message.type === "stdout"), false);
});

test("reliable results hold their own link busy until acknowledged without blocking another link", async t => {
  const a = hub(t), b = hub(t), la = link(a, "l1", []), lb = link(b, "l2", []);
  t.after(() => Promise.all([la.stop(), lb.stop()]));
  la.start(); lb.start(); await until(() => la.isUp() && lb.isUp());
  la.result("held-result", { native: true });
  assert.equal(la.busy(), true);
  assert.equal(lb.busy(), false);
  await until(() => a.messages.some(message => message.id === "held-result") && !la.busy());
  assert.equal(lb.isUp(), true);
});

test("rejected application results do not wedge maintenance and still replay when compatibility returns", async t => {
  const server = hub(t, LINK_PROTOCOL_VERSION - 1);
  const connection = link(server, "l1", [], { keepOnVersionMismatch: true });
  t.after(() => connection.stop());
  connection.result("pending-before-mismatch", { completed: true });
  assert.equal(connection.busy(), true, "a compatible but disconnected link still protects reliable results");
  connection.start();
  await until(() => server.hellos.length > 0 && !connection.busy());
  assert.equal(connection.isUp(), false);
  server.setMax(LINK_PROTOCOL_VERSION);
  await until(() => connection.isUp() && server.messages.some(message => message.id === "pending-before-mismatch"));
  assert.equal(server.messages.find(message => message.id === "pending-before-mismatch").result.completed, true);
});
