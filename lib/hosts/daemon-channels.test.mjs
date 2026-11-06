import assert from "node:assert/strict";
import test from "node:test";
import { ChannelTable } from "./daemon-channels.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SAVED = "11111111-1111-4111-8111-111111111111";
const MOVED = "22222222-2222-4222-8222-222222222222";
const launch = { cwd: "/tmp", recordedCwd: null, sessionFile: "/tmp/s.jsonl", advisor: false };
function harness(rejectNegotiation = false, launchAdvisor = false) {
  const children = [], output = [];
  const links = ["l1", "l2"].map(id => ({ id, version: 7, isUp: () => true,
    queue(body, key) { output.push({ id, body, key }); return 1; }, output(body) { output.push({ id, body }); }, discard() {} }));
  const table = new ChannelTable({ sessionId: () => SAVED, prepareLaunch: x => x, log() {},
    async spawn(request) {
      const listeners = {}, writes = [], exits = [];
      const transport = {
        write(line, callback) {
          const cmd = JSON.parse(line); writes.push(cmd); callback?.(null);
          const state = cmd.type === "get_state" ? (child.state ?? {}) : {};
          if (String(cmd.id).startsWith("d:")) queueMicrotask(() => listeners.line?.(JSON.stringify({
            type: "response", id: cmd.id, command: cmd.type,
            success: !(rejectNegotiation && cmd.type === "negotiate_protocol"),
            ...(rejectNegotiation && cmd.type === "negotiate_protocol" ? { error: "unsupported" } : { data: cmd.type === "negotiate_protocol" ? { protocolVersion: 2 } : state }),
          })));
        },
        killTree(force) { child.kills.push(force); if (!child.holdExit) child.exit(force); },
        onLine(fn) { listeners.line = fn; return () => {}; }, onStderr(fn) { listeners.stderr = fn; return () => {}; },
        onExit(fn) { exits.push(fn); return () => {}; },
      };
      const child = { transport, writes, kills: [], holdExit: false, exit(force = false) { for (const exit of exits) exit(0, force ? "SIGKILL" : null); }, emit(frame) { listeners.line?.(JSON.stringify(frame)); } }; children.push(child);
      setTimeout(() => child.emit({ type: "ready", supportedProtocolVersions: [1, 2] }), 0);
      return { transport, cwd: request.cwd, fellBack: false, launchAdvisor };
    } });
  return { table, children, output, a: links[0], b: links[1] };
}

test("concurrent opens spawn once; command order and replies stay source-owned", async () => {
  const h = harness();
  const [a,b] = await Promise.all([h.table.open(h.a,{ sessionId:SAVED,launch }),h.table.open(h.b,{ sessionId:SAVED,launch })]);
  assert.equal(h.children.length,1); assert.equal(a.ch,b.ch); h.table.release(h.a,a.ch);h.table.release(h.b,b.ch);
  h.table.stdin(h.a,a.ch,JSON.stringify({type:"get_state",id:"a"}));h.table.stdin(h.b,a.ch,JSON.stringify({type:"get_state",id:"b"}));
  assert.deepEqual(h.children[0].writes.filter(c=>!c.id.startsWith("d:")).map(c=>c.id),["a","b"]);
  for (const id of ["a","b","d:unknown"]) h.children[0].emit({type:"response",id,command:"get_state",success:true,data:{sessionId:SAVED}});
  assert.deepEqual(h.output.filter(x=>x.body.type==="stdout").map(x=>[x.id,JSON.parse(x.body.line).id]),[["l1","a"],["l2","b"]]);
  assert.throws(()=>h.table.stdin({...h.a,id:"guessed"},a.ch,'{}'));
  await h.table.stop();
});

test("shared opens report the actual advisor flag even when a joining link requests another mode", async () => {
  for (const [requested, forced] of [[false, false], [true, false], [false, true]]) {
    const h = harness(false, forced);
    const first = await h.table.open(h.a, { sessionId: SAVED, launch: { ...launch, advisor: requested } });
    const joined = await h.table.open(h.b, { sessionId: SAVED, launch: { ...launch, advisor: !requested } });
    assert.equal(first.advisorSpawned, requested || forced);
    assert.equal(joined.advisorSpawned, requested || forced);
    assert.equal(joined.launchAdvisor, forced);
    assert.equal(h.children.length, 1);
    await h.table.stop();
  }
});

test("an idle advisor replacement fences opens and correlates late stdin refusal before killing once", async () => {
  const h = harness(), first = await h.table.open(h.a, { sessionId: SAVED, launch });
  h.table.release(h.a, first.ch);
  const old = h.children[0]; old.holdExit = true;
  const replacement = h.table.open(h.b, { sessionId: SAVED, launch: { ...launch, advisor: true }, replaceAdvisor: true, preparing: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(old.kills, [false]);
  h.table.stdin(h.a, first.ch, JSON.stringify({ type: "prompt", id: "late-prompt", message: "must not disappear" }));
  const refused = h.output.filter(entry => entry.body.type === "stdout").map(entry => JSON.parse(entry.body.line)).find(frame => frame.id === "late-prompt");
  assert.equal(refused.command, "prompt");
  assert.equal(refused.success, false);
  assert.equal(refused.code, "session_restarting");
  assert.equal(old.writes.some(frame => frame.id === "late-prompt"), false);
  let joined = false;
  const joining = h.table.open(h.a, { sessionId: SAVED, launch }).then(result => { joined = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(joined, false);
  old.exit();
  const [next, peer] = await Promise.all([replacement, joining]);
  assert.notEqual(next.ch, first.ch);
  assert.equal(peer.ch, next.ch);
  assert.equal(next.advisorSpawned, true);
  assert.equal(h.children.length, 2);
  const held = await h.table.open(h.a, { sessionId: SAVED, launch, replaceAdvisor: true });
  assert.equal(held.ch, next.ch, "the source's preparation handoff protects its new child");
  h.table.setInterest(h.b, next.ch, true, false);
  await h.table.stop();
});

test("advisor changes never replace a peer command, unsettled background work, dialog or preparation", async () => {
  for (const phase of ["command", "acknowledged", "running", "unsettled", "dialog", "preparing"]) {
    const h = harness(), first = await h.table.open(h.a, { sessionId: SAVED, launch });
    h.table.release(h.a, first.ch);
    const child = h.children[0];
    if (phase === "command" || phase === "acknowledged") h.table.stdin(h.a, first.ch, JSON.stringify({ type: "prompt", id: "peer-prompt", message: "work" }));
    if (phase === "acknowledged") child.emit({ type: "response", id: "peer-prompt", command: "prompt", success: true, data: { agentInvoked: true } });
    if (phase === "running" || phase === "unsettled") child.emit({ type: "agent_start" });
    if (phase === "unsettled") child.emit({ type: "agent_end", isTerminal: true });
    if (phase === "dialog") child.emit({ type: "extension_ui_request", method: "ask", id: "answer-me" });
    if (phase === "preparing") h.table.setInterest(h.a, first.ch, false, true);
    const joined = await h.table.open(h.b, { sessionId: SAVED, launch: { ...launch, advisor: true }, replaceAdvisor: true });
    assert.equal(joined.ch, first.ch, phase);
    assert.equal(joined.advisorSpawned, false, phase);
    assert.deepEqual(child.kills, [], phase);
    await h.table.stop();
  }
});

test("join captures full stream and dialogs before later deltas; first answer closes the other UI",async()=>{
  const h=harness(), a=await h.table.open(h.a,{sessionId:SAVED,launch});h.table.release(h.a,a.ch);
  const child=h.children[0];child.emit({type:"message_start",messageId:"m",message:{role:"assistant",content:[{type:"text",text:"one"}]}});
  child.emit({type:"extension_ui_request",id:"q",method:"ask"});
  const b=await h.table.open(h.b,{sessionId:SAVED,launch});assert.equal(JSON.parse(b.streaming).message.content[0].text,"one");assert.equal(JSON.parse(b.pending[0]).id,"q");
  child.emit({type:"message_update",messageId:"m",message:{role:"assistant"},assistantMessageEvent:{type:"text_delta",contentIndex:0,delta:"two"}});
  assert.equal(h.output.filter(x=>x.id==="l2").length,0);h.table.release(h.b,b.ch);
  assert.equal(h.output.filter(x=>x.id==="l2").length,1);
  h.table.stdin(h.b,b.ch,JSON.stringify({type:"extension_ui_response",id:"q"}));h.table.stdin(h.a,a.ch,JSON.stringify({type:"extension_ui_response",id:"q"}));
  assert.equal(child.writes.filter(c=>c.type==="extension_ui_response").length,1);
  assert.ok(h.output.some(x=>x.id==="l1"&&JSON.parse(x.body.line).targetId==="q"));await h.table.stop();
});

test("a chunked private reply is never broadcast and session moves retain aliases",async()=>{
  const h=harness(),a=await h.table.open(h.a,{sessionId:SAVED,launch});h.table.release(h.a,a.ch);
  const b=await h.table.open(h.b,{sessionId:SAVED,launch});h.table.release(h.b,b.ch);
  h.children[0].emit({ type: "notice", source: "session-persistence", level: "info" });
  h.output.length = 0;
  h.table.stdin(h.a,a.ch,JSON.stringify({type:"get_state",id:"a"}));
  const bytes=Buffer.from(JSON.stringify({type:"response",id:"a",command:"get_state",success:true,data:{sessionId:MOVED,pad:"x".repeat(1100000)}}));
  const count=Math.ceil(bytes.length/262144);for(let index=0;index<count;index++)h.children[0].emit({type:"rpc_chunk",chunkId:"big",index,count,byteLength:bytes.length,data:bytes.subarray(index*262144,(index+1)*262144).toString("base64")});
  assert.equal(h.output.filter(x=>x.id==="l2").length,0);assert.equal(h.output.filter(x=>x.id==="l1").length,count);
  assert.equal((await h.table.open(h.b,{sessionId:SAVED,launch})).ch,a.ch);assert.equal((await h.table.open(h.b,{sessionId:MOVED,launch})).ch,a.ch);assert.equal(h.children.length,1);await h.table.stop();
});

test("legacy and shared channel collisions refuse both directions, never duplicate",async()=>{
  for(const legacyFirst of [false,true]){
    const h=harness();h.b.version=6;
    if(legacyFirst){await h.table.spawnLegacy(h.b,{...launch,ch:"old"});await assert.rejects(h.table.open(h.a,{sessionId:SAVED,launch}),e=>e.status===409&&e.code==="session_running_elsewhere");}
    else{await h.table.open(h.a,{sessionId:SAVED,launch});await assert.rejects(h.table.spawnLegacy(h.b,{...launch,ch:"old"}),e=>e.status===409&&e.code==="session_running_elsewhere");}
    assert.equal(h.children.length,1);await h.table.stop();
  }
});

test("startup negotiation precedes global settings and runs only once for two members", async () => {
  const h = harness();
  const a = await h.table.open(h.a, { sessionId: SAVED, launch });
  await h.table.open(h.b, { sessionId: SAVED, launch });
  assert.deepEqual(h.children[0].writes.map(command => command.type),
    ["negotiate_protocol", "set_event_filter", "set_subagent_subscription", "set_ask_dialog", "get_state"]);
  assert.equal(h.children[0].writes[1].messageUpdates, "delta");
  assert.deepEqual(h.output, []);
  h.table.release(h.a, a.ch); await h.table.stop();
});

test("closing one membership neither kills the child nor broadcasts its late reply", async () => {
  const h = harness(), a = await h.table.open(h.a, { sessionId: SAVED, launch });
  await h.table.open(h.b, { sessionId: SAVED, launch }); h.table.release(h.a, a.ch); h.table.release(h.b, a.ch);
  h.table.stdin(h.a, a.ch, JSON.stringify({ type: "get_state", id: "old" }));
  assert.throws(() => h.table.stdin(h.b, a.ch, JSON.stringify({ type: "get_state", id: "old" })));
  h.table.close(h.a, a.ch); h.children[0].emit({ type: "response", id: "old", success: true, command: "get_state", data: {} });
  assert.deepEqual(h.output, []); assert.equal(h.table.size, 1);
  assert.equal((await h.table.open(h.a, { sessionId: SAVED, launch })).joined, true);
  await h.table.stop();
});

test("delete fence waits for exit and prevents a concurrent reopen until the mutation completes", async () => {
  const h = harness(); await h.table.open(h.a, { sessionId: SAVED, launch });
  const gate = Promise.withResolvers(); let entered = false, reopened = false;
  const deletion = h.table.mutateSession(SAVED, async canonical => { assert.equal(canonical, SAVED); assert.equal(h.table.size, 0); entered = true; await gate.promise; return "deleted"; });
  const opening = h.table.open(h.b, { sessionId: SAVED, launch }).then(() => { reopened = true; });
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(entered, true); assert.equal(reopened, false);
  gate.resolve(); assert.equal(await deletion, "deleted"); await opening; assert.equal(h.children.length, 2); await h.table.stop();
});

test("a legal move's identity refresh fences opens under the new id", async () => {
  const h = harness(), a = await h.table.open(h.a, { sessionId: SAVED, launch });
  h.table.release(h.a, a.ch);
  h.children[0].emit({ type: "notice", source: "session-persistence", level: "info" });
  const request = h.children[0].writes.at(-1);
  assert.equal(request.type, "get_state");
  const opening = h.table.open(h.b, { sessionId: MOVED, launch: { ...launch, sessionFile: "/tmp/moved.jsonl" } });
  h.children[0].emit({ type: "response", id: request.id, command: "get_state", success: true, data: { sessionId: MOVED, sessionFile: "/tmp/moved.jsonl" } });
  assert.equal((await opening).ch, a.ch); assert.equal(h.children.length, 1); await h.table.stop();
});

test("recovery and two server opens share one spawn and one daemon-owned resume prompt", async () => {
  const h = harness();
  await Promise.all([
    h.table.recover([{ sessionId: SAVED, launch }]),
    h.table.open(h.a, { sessionId: SAVED, launch }),
    h.table.open(h.b, { sessionId: SAVED, launch }),
  ]);
  assert.equal(h.children.length, 1);
  const prompts = h.children[0].writes.filter(frame => frame.type === "prompt");
  assert.equal(prompts.length, 1); assert.ok(prompts[0].id.startsWith("d:")); assert.deepEqual(h.output, []);
  await h.table.stop();
});

test("only the chosen callback executor receives the request but both members receive the committed result", async () => {
  const h = harness(), a = await h.table.open(h.a, { sessionId: SAVED, launch });
  await h.table.open(h.b, { sessionId: SAVED, launch }); h.table.release(h.a, a.ch); h.table.release(h.b, a.ch);
  for (const link of [h.a, h.b]) h.table.setTools(link, a.ch, [{ name: "open_url" }], []);
  await new Promise(resolve => setImmediate(resolve)); // omp answers set_host_tools before it can call the tool
  h.table.stdin(h.b, a.ch, JSON.stringify({ type: "prompt", id: "p", message: "open" }));
  h.children[0].emit({ type: "host_tool_call", id: "call", toolName: "open_url", arguments: {} });
  // The non-prompting member sees only the daemon's peer-admission marker, never the callback.
  assert.deepEqual(h.output.map(item => [item.id, JSON.parse(item.body.line).type]), [["l1", "peer_message_command"], ["l2", "host_tool_call"]]);
  h.table.stdin(h.a, a.ch, JSON.stringify({ type: "host_tool_result", id: "call", result: "no" }));
  h.table.stdin(h.b, a.ch, JSON.stringify({ type: "host_tool_result", id: "call", result: "yes" }));
  assert.deepEqual(h.children[0].writes.filter(frame => frame.type === "host_tool_result").map(({ id, result }) => ({ id, result })), [{ id: "call", result: "yes" }]);
  h.children[0].emit({ type: "tool_execution_end", toolCallId: "call", toolName: "open_url", result: "yes" });
  assert.deepEqual(h.output.filter(item => JSON.parse(item.body.line).type === "tool_execution_end").map(item => item.id), ["l1", "l2"]);
  await h.table.stop();
});

test("an older omp rejects negotiation privately and remains usable with full updates", async () => {
  const h = harness(true), a = await h.table.open(h.a, { sessionId: SAVED, launch });
  assert.equal(h.children[0].writes[1].type, "set_event_filter");
  assert.equal(h.children[0].writes[1].messageUpdates, "full");
  h.table.release(h.a, a.ch);
  h.children[0].emit({ type: "message_update", messageId: "m", message: { role: "assistant", content: [{ type: "text", text: "full" }] } });
  assert.deepEqual(h.output.map(item => JSON.parse(item.body.line).message.content[0].text), ["full"]);
  await h.table.stop();
});

test("permanent legacy-owner removal reaps only its exclusive child; shared removal never kills", async () => {
  const h = harness(); h.a.version = 6; h.b.version = 6;
  await h.table.spawnLegacy(h.a, { ...launch, ch: "legacy-a" });
  await h.table.spawnLegacy(h.b, { ...launch, sessionFile: "", ch: "legacy-b" });
  h.table.linkDown(h.a); assert.equal(h.table.size, 2);
  h.table.linkGone(h.a); assert.equal(h.table.size, 1);
  assert.deepEqual(h.table.members("legacy-b").map(link => link.id), ["l2"]);
  await h.table.stop();
  const shared = harness(); await shared.table.open(shared.a, { sessionId: SAVED, launch });
  shared.table.linkGone(shared.a); assert.equal(shared.table.size, 1); await shared.table.stop();
});

test("permanent removal during spawn cannot strand an exclusive child or attach a dead shared member", async () => {
  const legacy = harness(); legacy.a.version = 6;
  const spawning = legacy.table.spawnLegacy(legacy.a, { ...launch, ch: "legacy" });
  legacy.table.linkGone(legacy.a);
  await assert.rejects(spawning, error => error.code === "host_link_closed"); assert.equal(legacy.table.size, 0);
  await legacy.table.stop();
  const shared = harness();
  const a = shared.table.open(shared.a, { sessionId: SAVED, launch });
  const b = shared.table.open(shared.b, { sessionId: SAVED, launch });
  shared.table.linkGone(shared.a);
  await assert.rejects(a, error => error.code === "host_link_closed");
  const opened = await b; assert.deepEqual(shared.table.members(opened.ch).map(link => link.id), ["l2"]);
  assert.equal(shared.children.length, 1); await shared.table.stop();
});

test("concurrent opens by one member release live output only after both results are published", async () => {
  const h = harness();
  const [first, second] = await Promise.all([h.table.open(h.a, { sessionId: SAVED, launch }), h.table.open(h.a, { sessionId: SAVED, launch })]);
  h.children[0].emit({ type: "message_start", messageId: "m", message: { role: "assistant", content: [] } });
  h.table.release(h.a, first.ch); assert.deepEqual(h.output, []);
  h.table.release(h.a, second.ch); assert.equal(h.output.length, 1);
  await h.table.stop();
});

for (const operation of ["open", "delete"]) {
  test(`a fork keeps its parent independent when the parent is ${operation}d`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-fork-identity-"));
    const parent = join(dir, "parent.jsonl"), fork = join(dir, "fork.jsonl");
    for (const [file, id] of [[parent, SAVED], [fork, MOVED]]) writeFileSync(file, `${JSON.stringify({
      type: "session", version: 3, id, cwd: "/tmp", timestamp: "2026-01-01T00:00:00Z",
    })}\n`);
    const h = harness();
    try {
      const original = await h.table.open(h.a, { sessionId: SAVED, launch: { ...launch, sessionFile: parent } });
      h.children[0].emit({ type: "response", command: "get_state", success: true, data: { sessionId: MOVED, sessionFile: fork } });
      if (operation === "open") {
        const reopened = await h.table.open(h.b, { sessionId: SAVED, launch: { ...launch, sessionFile: parent } });
        assert.notEqual(reopened.ch, original.ch);
        assert.equal(h.children.length, 2);
      } else {
        await h.table.mutateSession(SAVED, async canonical => {
          assert.equal(canonical, SAVED, "deleting the parent must never target the fork");
          assert.equal(h.table.size, 1, "the fork's process must remain alive");
        });
      }
    } finally {
      await h.table.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("a native copy-on-write move retains aliases even while the original file still exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-native-move-"));
  const parent = join(dir, "original.jsonl"), moved = join(dir, "moved.jsonl");
  writeFileSync(parent, `${JSON.stringify({ type: "session", version: 3, id: SAVED, cwd: "/tmp" })}\n`);
  const h = harness();
  try {
    const opened = await h.table.open(h.a, { sessionId: SAVED, launch: { ...launch, sessionFile: parent } });
    h.children[0].emit({ type: "notice", source: "session-persistence", level: "info", message: "Session moved" });
    const refresh = h.children[0].writes.at(-1);
    h.children[0].emit({ type: "response", id: refresh.id, command: "get_state", success: true, data: { sessionId: MOVED, sessionFile: moved } });
    assert.equal((await h.table.open(h.b, { sessionId: SAVED, launch: { ...launch, sessionFile: parent } })).ch, opened.ch);
    assert.equal((await h.table.open(h.b, { sessionId: MOVED, launch: { ...launch, sessionFile: moved } })).ch, opened.ch);
    assert.equal(h.children.length, 1);
  } finally {
    await h.table.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a new source's preparation lease survives startup until its first command owns it", async () => {
  const h = harness();
  const first = await h.table.open(h.a, { sessionId: SAVED, launch, preparing: true });
  const protectedJoin = await h.table.open(h.b, { sessionId: SAVED, launch: { ...launch, advisor: true }, replaceAdvisor: true });
  assert.equal(protectedJoin.ch, first.ch);
  assert.deepEqual(h.children[0].kills, []);
  h.table.setInterest(h.a, first.ch, true, false);
  const changed = await h.table.open(h.b, { sessionId: SAVED, launch: { ...launch, advisor: true }, replaceAdvisor: true });
  assert.notEqual(changed.ch, first.ch);
  assert.equal(changed.advisorSpawned, true);
  await h.table.stop();
});

test("a passive join for an exited advertised channel never respawns its saved file", async () => {
  const h = harness();
  const first = await h.table.open(h.a, { sessionId: SAVED, launch });
  h.children[0].exit();
  await assert.rejects(h.table.open(h.b, { sessionId: SAVED, launch, expectedChannel: first.ch }),
    error => error.status === 404 && error.code === "session_not_running");
  assert.equal(h.children.length, 1);
  assert.equal(h.table.size, 0);
  await h.table.stop();
});

test("destructive operations on an old copy-on-write file never retarget its live continuation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-native-move-delete-"));
  const original = join(dir, "original.jsonl"), moved = join(dir, "moved.jsonl");
  writeFileSync(original, `${JSON.stringify({ type: "session", version: 3, id: SAVED, cwd: "/tmp" })}\n`);
  const h = harness();
  try {
    await h.table.open(h.a, { sessionId: SAVED, launch: { ...launch, sessionFile: original } });
    h.children[0].emit({ type: "notice", source: "session-persistence", level: "info", message: "Session moved" });
    const refresh = h.children[0].writes.at(-1);
    h.children[0].emit({ type: "response", id: refresh.id, command: "get_state", success: true, data: { sessionId: MOVED, sessionFile: moved } });
    let requested;
    await h.table.mutateSession(SAVED, async id => { requested = id; });
    assert.equal(requested, SAVED);
    assert.equal(h.table.size, 1);
    assert.deepEqual(h.children[0].kills, [], "the moved session's process still owns only the continuation");
  } finally {
    await h.table.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit close releases only its own preparation handoff, including startup failure cleanup", async () => {
  const h = harness();
  const first = await h.table.open(h.a, { sessionId: SAVED, launch, preparing: true });
  await h.table.open(h.b, { sessionId: SAVED, launch, preparing: true });
  h.table.close(h.a, first.ch);
  const held = await h.table.open(h.a, { sessionId: SAVED, launch: { ...launch, advisor: true }, replaceAdvisor: true });
  assert.equal(held.ch, first.ch, "the other member's preparation remains protected");
  h.table.close(h.b, first.ch);
  const replaced = await h.table.open(h.a, { sessionId: SAVED, launch: { ...launch, advisor: true }, replaceAdvisor: true });
  assert.notEqual(replaced.ch, first.ch, "closed members leave no residual preparation lease");
  await h.table.stop();
});

test("a recovering run is protected from a competing advisor open before its resume prompt starts", async () => {
  const h = harness();
  const [, joined] = await Promise.all([
    h.table.recover([{ sessionId: SAVED, launch }]),
    h.table.open(h.b, { sessionId: SAVED, launch: { ...launch, advisor: true }, replaceAdvisor: true }),
  ]);
  assert.equal(h.children.length, 1);
  assert.equal(joined.advisorSpawned, false);
  assert.deepEqual(h.children[0].kills, []);
  assert.equal(h.children[0].writes.filter(frame => frame.type === "prompt").length, 1);
  await h.table.stop();
});

test("a move notice during an older identity read schedules a fresh native identity snapshot", async () => {
  const h = harness();
  try {
    const opened = await h.table.open(h.a, { sessionId: SAVED, launch });
    h.table.release(h.a, opened.ch);
    const child = h.children[0];
    child.state = { sessionId: SAVED, sessionFile: launch.sessionFile };
    child.emit({ type: "agent_start" });
    child.state = { sessionId: MOVED, sessionFile: "/tmp/moved-after-snapshot.jsonl" };
    child.emit({ type: "notice", source: "session-persistence", level: "info", message: "Session moved" });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(h.table.listing(h.a)[0].sessionId, MOVED);
    assert.equal(h.children.length, 1);
  } finally { await h.table.stop(); }
});

test("a history-edit lease refuses a competing editor and other links' mutations until released, dropped or closed", async () => {
  const h = harness(), a = await h.table.open(h.a, { sessionId: SAVED, launch });
  await h.table.open(h.b, { sessionId: SAVED, launch }); h.table.release(h.a, a.ch); h.table.release(h.b, a.ch);
  const prompts = () => h.children[0].writes.filter(frame => frame.type === "prompt").map(frame => frame.id);
  h.table.editLease(h.a, a.ch, true);
  assert.throws(() => h.table.editLease(h.b, a.ch, true), { status: 409, code: "session_busy" }, "a competing editor fails before its preflight");
  h.table.editLease(h.b, a.ch, false); // Releasing a lease it does not hold changes nothing.
  h.table.stdin(h.b, a.ch, JSON.stringify({ type: "prompt", id: "peer", message: "x" }));
  h.table.stdin(h.b, a.ch, JSON.stringify({ type: "get_state", id: "read" }));
  h.table.stdin(h.a, a.ch, JSON.stringify({ type: "prompt", id: "edit", message: "/edit" }));
  assert.deepEqual(prompts(), ["edit"]);
  assert.ok(h.children[0].writes.some(frame => frame.id === "read"), "reads are never fenced");
  const refused = h.output.filter(item => item.id === "l2" && item.body.type === "stdout").map(item => JSON.parse(item.body.line)).find(frame => frame.id === "peer");
  assert.equal(refused?.code, "session_busy");
  h.table.editLease(h.a, a.ch, false);
  h.table.editLease(h.b, a.ch, true); h.table.editLease(h.b, a.ch, false); // Free again: B may take it.
  h.table.stdin(h.b, a.ch, JSON.stringify({ type: "prompt", id: "after", message: "x" }));
  h.table.editLease(h.a, a.ch, true); h.table.linkDown(h.a); // A restarted server forgets its edit.
  h.table.stdin(h.b, a.ch, JSON.stringify({ type: "prompt", id: "dropped", message: "x" }));
  h.table.editLease(h.a, a.ch, true); h.table.close(h.a, a.ch);
  h.table.stdin(h.b, a.ch, JSON.stringify({ type: "prompt", id: "closed", message: "x" }));
  assert.deepEqual(prompts(), ["edit", "after", "dropped", "closed"]);
  await h.table.stop();
});

test("an exit between join and the open result's release still reaches the joining link", async () => {
  const h = harness(), a = await h.table.open(h.a, { sessionId: SAVED, launch });
  h.children[0].exit();
  assert.deepEqual(h.output.filter(item => item.body.type === "exit"), []);
  h.table.release(h.a, a.ch);
  assert.deepEqual(h.output.filter(item => item.body.type === "exit").map(item => item.id), ["l1"]);
  await h.table.stop();
});

test("a reopen keeps this link's queued command replies and drops output its snapshot supersedes", async () => {
  const h = harness(), a = await h.table.open(h.a, { sessionId: SAVED, launch });
  h.table.stdin(h.a, a.ch, JSON.stringify({ type: "get_state", id: "q" }));
  h.children[0].emit({ type: "response", id: "q", command: "get_state", success: true, data: { sessionId: SAVED } });
  h.children[0].emit({ type: "notice", message: "stale" });
  await h.table.open(h.a, { sessionId: SAVED, launch, expectedChannel: a.ch });
  h.table.release(h.a, a.ch); h.table.release(h.a, a.ch);
  assert.deepEqual(h.output.filter(item => item.body.type === "stdout").map(item => JSON.parse(item.body.line).id ?? "output"), ["q"]);
  await h.table.stop();
});

test("a stop the daemon makes names its reason on the exit; a crash names none", async () => {
  const h = harness(), a = await h.table.open(h.a, { sessionId: SAVED, launch }); h.table.release(h.a, a.ch);
  h.table.kill(h.a, a.ch, false);
  assert.deepEqual(h.output.filter(item => item.body.type === "exit").map(item => item.body.reason), ["asked"]);
  const b = await h.table.open(h.a, { sessionId: SAVED, launch }); h.table.release(h.a, b.ch);
  h.children[1].exit();
  assert.deepEqual(h.output.filter(item => item.body.type === "exit").map(item => item.body.reason), ["asked", undefined]);
  await h.table.stop();
});

test("a resumed session stays recorded as running between omp's reply and agent_start", async () => {
  const h = harness(), entry = { sessionId: SAVED, launch };
  assert.deepEqual(await h.table.recover([entry]), [], "the harness answers the prompt before any agent_start");
  assert.deepEqual(h.table.running().map(item => item.sessionId), [SAVED], "no gap where a crash would lose the resume");
  h.children[0].emit({ type: "agent_start" });
  h.children[0].emit({ type: "agent_end", isTerminal: true });
  h.children[0].emit({ type: "session_settled" });
  assert.deepEqual(h.table.running(), [], "a finished resumed run is no longer recorded");
  await h.table.stop();
});
