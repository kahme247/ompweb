import assert from 'node:assert/strict';
import '../tests/setup-dom.mjs';
import test, {afterEach} from 'node:test';
import React from 'react';
const {render,cleanup,fireEvent}=await import('@testing-library/react/pure.js');
const {ChatLiveTail}=await import('./ChatWindow-live-tail.tsx');
const {streamReducer}=await import('../hooks/useAgentSession-stream.ts');
afterEach(cleanup);
const reply={role:'assistant',provider:'p',model:'m',timestamp:1700000000000,content:[{type:'text',text:'hello'}]};
const props={streamingMessage:reply,isStreaming:true,liveTokensPerSecond:42,pendingToolHeaders:[],deferredBash:[],pendingBash:null,toolResults:new Map(),modelNames:{},cwd:undefined,sessionId:'s',toolCallsDefaultCollapsed:true,expandThinkingByDefault:false,hideThinking:false};
const node=p=>React.createElement(ChatLiveTail,{...props,...p});
test('same reply transitions live to held to committed without stale memo state',()=>{
 const v=render(node());
 v.rerender(node({liveTokensPerSecond:12}));assert.match(v.container.textContent,/12\.0 t\/s/);
 const held=streamReducer({isStreaming:true,streamingMessage:reply},{type:'hold',message:reply});
 v.rerender(node(held));assert.equal(v.container.querySelector('[data-live]'),null);assert.ok(v.container.querySelector('.message-assistant-footer'));
 v.rerender(node(streamReducer(held,{type:'release',committed:[reply]})));assert.equal(v.container.textContent,'');
});
test('empty and thinking-only streams respect thinking preference and hide settings',()=>{
 const empty={...reply,content:[]};const v=render(node({streamingMessage:empty}));assert.ok(v.container.querySelector('[data-live]'));
 const thinking={...reply,content:[{type:'thinking',thinking:''}]};
 v.rerender(node({streamingMessage:thinking,expandThinkingByDefault:true}));assert.ok(v.container.querySelector('.activity-row'));
 v.rerender(node({streamingMessage:thinking,isStreaming:false}));assert.equal(v.container.textContent,'');
 v.rerender(node({streamingMessage:{...thinking,content:[{type:'thinking',thinking:'secret thought'}]},hideThinking:true}));assert.doesNotMatch(v.container.textContent,/secret thought/);
});
test('live tool preferences show spinners and preserve committed result priority',()=>{
 const call={type:'toolCall',toolCallId:'t',toolName:'bash',input:{command:'pwd'}};
 const message={...reply,content:[call]};const v=render(node({streamingMessage:message}));
 assert.ok(v.container.querySelector('.activity-row-spinner'));assert.equal(v.container.querySelector('[aria-expanded]').getAttribute('aria-expanded'),'false');
 v.unmount();const w=render(node({streamingMessage:message,toolCallsDefaultCollapsed:false}));assert.equal(w.container.querySelector('[aria-expanded]').getAttribute('aria-expanded'),'true');
 w.rerender(node({streamingMessage:message,toolCallsDefaultCollapsed:false,toolResults:new Map([['t',{role:'toolResult',toolCallId:'t',content:[{type:'text',text:'done'}]}]])}));assert.equal(w.container.querySelector('.activity-row-spinner'),null);
});
test('incomplete code and hostile links remain safe while streaming and held',()=>{
 const message={...reply,content:[{type:'text',text:'[bad](javascript:alert(1))\n\n<script>alert(1)</script>\n\n```js\nconst a = 1;'}]};
 const v=render(node({streamingMessage:message}));assert.equal(v.container.querySelector('script'),null);assert.equal(v.container.querySelector('[href^="javascript:"]'),null);assert.equal(v.container.querySelector('.linenumber'),null);
 v.rerender(node({streamingMessage:message,isStreaming:false}));assert.equal(v.container.querySelector('script'),null);assert.equal(v.container.querySelector('[href^="javascript:"]'),null);assert.ok(v.container.querySelector('.message-assistant-footer'));
});
test('quota banner remains visible for empty live response and held response',()=>{
 const message={...reply,content:[],stopReason:'error',errorMessage:'Quota exceeded'};const v=render(node({streamingMessage:message}));assert.match(v.container.querySelector('[role="alert"]').textContent,/Quota exceeded/);
 v.rerender(node({streamingMessage:message,isStreaming:false}));assert.match(v.container.querySelector('[role="alert"]').textContent,/Quota exceeded/);
});
