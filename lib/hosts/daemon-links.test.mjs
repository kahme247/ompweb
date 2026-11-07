import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeLine, LINK_LIMITS } from "./link-protocol.ts";

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
function hub(t, max=7){
  const hellos=[],messages=[];let socket,ack=0;
  const server=Bun.serve({port:0,hostname:"127.0.0.1",fetch(req,s){return s.upgrade(req)?undefined:new Response("",{status:426});},websocket:{message(ws,data){if(typeof data!=="string")return;for(const line of data.split("\n").filter(Boolean)){const m=JSON.parse(line);if(m.type==="hello"){hellos.push(m);socket=ws;if(m.v>max){ws.close(4426,JSON.stringify({serverVersion:max}));continue;}ws.send(encodeLine({type:"welcome",v:max,hostId:"h"}));}else if(m.seq){messages.push(m);ack=m.seq;}}if(ws.readyState===1)ws.send(encodeLine({type:"ack",ack}));}}});t.after(()=>server.stop(true));
  return {url:`http://127.0.0.1:${server.port}`,hellos,messages,close:(code)=>socket.close(code)};
}
function link(server,id,ends){return new DaemonLink({url:server.url,token:"test"},id,{allowHttp:false,primary:id==="l1",hello:(link)=>encodeLine({type:"hello",v:link.version,ompVersion:null,platform:"linux",home:"/tmp",autoApproveExtension:false,ack:link.ackedDown,channels:[],...(link.version>=7?{link:{id:link.id,notifier:false}}:{})}),handleDown(){},onEnd:(link,reason)=>ends.push([link.id,reason]),log(){}});}

test("two independent links negotiate versions and ending one leaves the other live",async t=>{
  const a=hub(t),b=hub(t,6),ends=[],la=link(a,"l1",ends),lb=link(b,"l2",ends);t.after(()=>Promise.all([la.stop(),lb.stop()]));la.start();lb.start();
  await until(()=>la.isUp()&&lb.isUp());assert.equal(a.hellos[0].link.id,"l1");assert.equal(b.hellos[0].link.id,"l2");assert.equal(b.hellos.at(-1).v,6);
  a.close(4409);await until(()=>ends.length===1);assert.equal(lb.isUp(),true);assert.deepEqual(ends,[["l1","replaced"]]);
  lb.queue({type:"sessions_changed"},"sessions");await until(()=>b.messages.some(m=>m.type==="sessions_changed"));
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
