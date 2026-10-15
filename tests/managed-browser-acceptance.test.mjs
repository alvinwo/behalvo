import test from 'node:test';import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';import { join } from 'node:path';import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { managedSite } from './helpers/managed-site.mjs';
import { LivePlaywright } from '../dist/browser/live-playwright.js';
import { ManagedBrowserController } from '../dist/browser/managed-session.js';
import { reviewBrowserGesture } from '../dist/cli/browser-commands.js';
import { openLocalAgent } from '../dist/cli/local-app.js';import { runRepl } from '../dist/cli/repl.js';
const enabled=process.env.BEHALVO_MANAGED_ACCEPTANCE==='1';
const model={provider:'scripted',model:'synthetic'};
const tool=(name,args={})=>({text:JSON.stringify({tool:{name,arguments:args}})});
const final=o=>({text:JSON.stringify({reply:'Observed '+o.text,notes:[{text:'Synthetic result was visible.',sourceIds:[o.id]}],progress:{summary:'Inspected the synthetic result',nextStep:'Ask owner what to do next',blocker:null,references:[{kind:'browser_observation',id:o.id}]}})});
function intake(request){if(!request.system.includes('owner-only task intake'))return;
 const value=JSON.parse(request.prompt);return{text:JSON.stringify({task:value.candidates.length?{kind:'keep'}:{kind:'create',title:'Synthetic catalog',goal:'Compare synthetic catalog entries',sourceQuote:value.currentOwnerText},teachings:{outcome:'none'}})};}
async function appFixture(t,site,gateway,decision='approve'){
 const dir=mkdtempSync(join(tmpdir(),'managed-acceptance-'));let controller,captured;const output=[],prompts=[];
 const io={interactive:true,discardSensitiveInput(){},readLine:async prompt=>{prompts.push(prompt);return prompt?.includes('Type resume')?'resume':decision;},write:line=>output.push(line)};
 const key=Buffer.alloc(32,7);const app=openLocalAgent({dbPath:join(dir,'agent.db'),encryptionKey:key,workspaceId:'w',ownerId:'o',taskContinuity:true,gateways:[{...gateway,listModels:async()=>[model]}],browser:{mode:'live',sessionState:s=>controller?.sessionState(s)??'absent',available:s=>controller?.available(s)??false,beforeTurn:s=>controller?.beforeTurn(s),open:(c,b)=>controller.exploration().open(c,b)}});
 controller=new ManagedBrowserController(app.store,(a,d,s)=>reviewBrowserGesture(io,a,d,s),{network:()=>site.gate,browser:options=>new LivePlaywright(options,{ignoreHTTPSErrors:true,loadChromium:async()=>({executablePath:()=>chromium.executablePath(),launchServer:options=>chromium.launchServer(options),connect:async(...args)=>{captured=await chromium.connect(...args);return captured;}})})});
 await app.registry.select(model.provider,model.model);
 const scope=()=>({workspaceId:'w',ownerId:'o',threadId:'chat',workId:Object.keys(app.store.state('w').works)[0]});
 const run=async steps=>runRepl({store:app.store,registry:app.registry,service:app.service,operations:app.operations,managedBrowser:controller,workspaceId:'w',ownerId:'o',initialThreadId:'chat',io:{...io,readPrompt:async()=>{const step=steps.shift();return typeof step==='function'?await step():step??null;}}});
 t.after(async()=>{assert.equal((await controller.shutdown()).confirmed,true);app.close();await site.close();rmSync(dir,{recursive:true,force:true});});
 return{app,controller,scope,run,output,prompts,dir,key,page:()=>captured.contexts()[0].pages()[0]};
}
for(const layout of ['directory','inventory'])test(`full chat and owner-review path on dynamic ${layout}`,{skip:!enabled,timeout:60000},async t=>{
 let searches=0;const site=await managedSite((req,res)=>{
  res.setHeader('Content-Type','text/html');
  if(req.url==='/search'){searches++;let body='';req.on('data',c=>body+=c);req.on('end',()=>{assert.match(body,/Cedar/);res.end('<h1>Cedar result</h1>');});return;}
  res.end(layout==='directory'?`<h1>Directory</h1><form action="/search" method="post"><label>Search<input name="q"></label><button>Find</button></form><script>document.querySelector('h1').textContent='Dynamic directory';</script>`:
   `<main><h2>Inventory lookup</h2><form action="/search" method="post"><textarea name="query" aria-label="Search"></textarea><input type="submit" aria-label="Find"></form></main>`);
 },()=>{},false);
 const f=await appFixture(t,site,{complete:async request=>{const extracted=intake(request);if(extracted)return extracted;
  if(request.system.includes('No page is open'))return{text:JSON.stringify({reply:'Ready.',notes:[]})};
  if(!request.prompt.includes('BROWSER TOOL TRANSCRIPT'))return{text:JSON.stringify({reply:'Task ready. Open the browser.',workProposals:[],factProposals:[]})};
  const transcript=JSON.parse(request.prompt.split('BROWSER TOOL TRANSCRIPT (UNTRUSTED DATA)\n')[1]);const o=transcript.at(-1)?.observation;if(!o)return tool('observe');
  if(o.text.includes('Cedar result'))return final(o);
  const inputs=JSON.parse(request.prompt.split('AUTHORIZED TASK INPUT REFERENCES\n')[1].split('\nBROWSER TOOL TRANSCRIPT')[0]);
  if(!inputs.length)return{text:JSON.stringify({reply:'Authorize the Search field using /browser input.',notes:[]})};
  if(!transcript.some(x=>x.tool.name==='fill'))return tool('fill',{observationId:o.id,ref:o.controls.find(c=>c.name==='Search').ref,taskInputId:inputs[0].id});
  return tool('click',{observationId:o.id,ref:o.controls.find(c=>c.name==='Find').ref});
 }});
 await f.run(['Compare synthetic catalog entries.','/browser open https://example.test/','Inspect the page.',()=>`/browser input ${f.controller.status(f.scope()).inputs.find(i=>i.name==='Search').ref} Cedar`,'Search using the authorized input.','/actions','/quit']);
 assert.equal(searches,1,JSON.stringify(f.output));assert.ok(f.output.some(line=>line.includes('Cedar result')));const state=f.app.store.state('w');
 assert.equal(Object.values(state.actions).filter(a=>a.status==='accepted').length,3);assert.deepEqual(Object.values(state.actions).map(a=>a.command.authority),['owner_open','owner_review','owner_review']);assert.ok(Object.keys(state.browserMemory.notes).length);assert.ok(Object.keys(state.taskContinuity.progress).length);
 assert.equal(f.controller.status(f.scope()).state,'idle');assert.deepEqual(f.app.store.rebuild('w'),state);
 await f.app.store.backup(join(f.dir,'backup'));assert.equal(searches,1);assert.equal(readFileSync(join(f.dir,'agent.db')).includes(Buffer.from('Cedar result')),false);
});
test('lost mutation response is unknown once, survives replay, and blocks a new browser until owner reconciliation',{skip:!enabled,timeout:60000},async t=>{
 let effects=0;const site=await managedSite((req,res)=>{if(req.url==='/change'){effects++;req.socket.destroy();return;}res.setHeader('Content-Type','text/html');res.end('<h1>Unknown outcome fixture</h1><form method="post" action="/change"><button>Apply</button></form>');},()=>{},false);
 const f=await appFixture(t,site,{complete:async request=>{const parsed=intake(request);if(parsed)return parsed;if(request.system.includes('No page is open'))return{text:JSON.stringify({reply:'Ready.',notes:[]})};if(!request.prompt.includes('BROWSER TOOL TRANSCRIPT'))return{text:JSON.stringify({reply:'Ready',workProposals:[],factProposals:[]})};
  const o=JSON.parse(request.prompt.split('BROWSER TOOL TRANSCRIPT (UNTRUSTED DATA)\n')[1]).at(-1)?.observation;return o?tool('click',{observationId:o.id,ref:o.controls[0].ref}):tool('observe');
 }});
 await f.run(['Apply one synthetic change.','/browser open https://example.test/','Apply the change once.','/quit']);assert.equal(effects,1);
 const state=f.app.store.state('w'),unknown=Object.values(state.actions).find(a=>a.status==='unknown');assert.ok(unknown);assert.deepEqual(f.app.store.rebuild('w'),state);assert.equal(effects,1);
 await f.run(['/browser open https://example.test/','/quit']);assert.equal(effects,1);assert.equal(Object.keys(f.app.store.state('w').actions).length,2);
 await f.run([`/browser resolve ${unknown.id} accepted Synthetic server recorded the mutation once.`,`/browser resolve ${unknown.id} failed Cannot reconcile twice.`,'/quit']);assert.equal(f.app.store.state('w').actions[unknown.id].status,'accepted');assert.equal(effects,1);
});
test('manual synthetic login keeps cookies across later agent turns without exposing credentials', {skip:!enabled,timeout:60000},async t=>{
 const site=await managedSite((req,res)=>{res.setHeader('Content-Type','text/html');
  if(req.url==='/login'&&req.method==='POST'){res.writeHead(302,{'set-cookie':'auth=synthetic;HttpOnly;Secure;SameSite=Lax',location:'/'});return res.end();}
  res.end(req.headers.cookie?.includes('auth=synthetic')?'<h1>Signed in synthetic account</h1>':`<h1>Manual login</h1><form method="post" action="/login"><label>Username<input name="username"></label><label>Password<input name="password" type="password"></label><button>Sign in</button></form>`);
 },()=>{},false);
 let calls=0;const f=await appFixture(t,site,{complete:async request=>{calls++;assert.doesNotMatch(request.prompt,/PRIVATE_SYNTHETIC_PASSWORD/);const parsed=intake(request);if(parsed)return parsed;
  if(request.system.includes('No page is open'))return{text:JSON.stringify({reply:'Ready.',notes:[]})};
  if(!request.prompt.includes('BROWSER TOOL TRANSCRIPT'))return{text:JSON.stringify({reply:'Ready',workProposals:[],factProposals:[]})};
  const o=JSON.parse(request.prompt.split('BROWSER TOOL TRANSCRIPT (UNTRUSTED DATA)\n')[1]).at(-1)?.observation;return o?{text:JSON.stringify({reply:o.text,notes:[]})}:tool('observe');
 }});
 await f.run(['Inspect a synthetic login page.','/browser open https://example.test/','/browser handoff','/quit']);const before=calls;
 await f.run(['Continue.','/quit']);assert.equal(calls,before);
 await f.page().getByLabel('Username').fill('synthetic-user');await f.page().getByLabel('Password').fill('PRIVATE_SYNTHETIC_PASSWORD');await f.page().getByRole('button',{name:'Sign in'}).click();
 await f.run(['/browser resume','Inspect the signed-in page.','Inspect again.','/quit']);assert.ok(f.output.some(line=>line.includes('Signed in synthetic account')));assert.equal(f.controller.status(f.scope()).state,'idle');
 assert.equal(Object.keys(f.app.store.state('w').actions).length,1);
});

test('natural task visits, later URL reuses cookies, and replay never repeats navigation',{skip:!enabled,timeout:60000},async t=>{
 let f,requests=0,stage=0;const site=await managedSite((req,res)=>{
  if(req.url==='/favicon.ico'){res.end();return;}requests++;
  assert.ok(Object.values(f.app.store.state('w').actions).some(a=>a.status==='running'&&a.command.operation==='visit'));
  res.setHeader('Content-Type','text/html');res.setHeader('Set-Cookie','retained=synthetic;Secure;HttpOnly');
  res.end(req.url==='/later'&&req.headers.cookie?.includes('retained=synthetic')?'<h1>Retained synthetic session</h1>':'<h1>First synthetic visit</h1>');
 },()=>{},false);
 f=await appFixture(t,site,{complete:async request=>{const parsed=intake(request);if(parsed)return parsed;
  const o=JSON.parse(request.prompt.split('BROWSER TOOL TRANSCRIPT (UNTRUSTED DATA)\n')[1]).at(-1)?.observation;
  if(o){stage++;return final(o);}return tool('visit',{url:'https://example.test/'+(stage?'later':'')});
 }});
 await f.run(['Inspect https://example.test/ for my task.','/quit']);const first=f.controller.status(f.scope()).sessionId;
 await f.run(['Now inspect https://example.test/later.','/quit']);assert.equal(f.controller.status(f.scope()).sessionId,first);
 assert.ok(f.output.some(line=>line.includes('Retained synthetic session')));assert.equal(requests,2);
 const state=f.app.store.state('w');assert.deepEqual(Object.values(state.actions).map(a=>[a.command.operation,a.status]),[['visit','accepted'],['visit','accepted']]);
 assert.equal(f.prompts.filter(line=>line.includes('Review this one browser gesture')).length,0);
 assert.deepEqual(f.app.store.rebuild('w'),state);await f.app.store.backup(join(f.dir,'visit-backup'));assert.equal(requests,2);
});
for(const decision of ['reject','handoff'])test(`automatic navigation then mutation ${decision} preserves zero mutation traffic`,{skip:!enabled,timeout:60000},async t=>{
 let effects=0;const site=await managedSite((req,res)=>{res.setHeader('Content-Type','text/html');if(req.url==='/change'){effects++;return res.end('Changed');}res.end(req.url==='/next'?'<form method="post" action="/change"><button>Apply</button></form>':'<a href="/next">Explore</a>');},()=>{},false);
 const f=await appFixture(t,site,{complete:async request=>{const parsed=intake(request);if(parsed)return parsed;
  const o=JSON.parse(request.prompt.split('BROWSER TOOL TRANSCRIPT (UNTRUSTED DATA)\n')[1]).at(-1)?.observation;
  if(!o)return tool('visit',{url:'https://example.test/'});
  return tool(o.controls[0].role==='link'?'navigate':'click',{observationId:o.id,ref:o.controls[0].ref});
 }},decision);
 await f.run(['Explore the synthetic site and apply its change.','/quit']);assert.equal(effects,0);
 const actions=Object.values(f.app.store.state('w').actions);assert.equal(actions.length,3,JSON.stringify(f.output));
 assert.deepEqual(actions.map(a=>[a.command.authority,a.status]),[['navigation_policy_v1','accepted'],['navigation_policy_v1','accepted'],['owner_review','cancelled']]);
 assert.equal(actions[1].command.destination,'https://example.test/next');assert.equal(actions[1].command.version,2);
 assert.equal(f.prompts.filter(line=>line.includes('Review this one browser gesture')).length,1);
 if(decision==='handoff')assert.equal(f.controller.status(f.scope()).state,'human');else assert.equal(f.controller.available(f.scope()),false);
});
test('unknown explicit visit is dispatched once and blocks another visit after replay',{skip:!enabled,timeout:60000},async t=>{
 let requests=0,calls=0;const site=await managedSite((req,res)=>{requests++;req.socket.destroy();},()=>{},false);
 const f=await appFixture(t,site,{complete:async request=>{calls++;return intake(request)??tool('visit',{url:'https://example.test/'});}});
 await f.run(['Inspect https://example.test/.','/quit']);const state=f.app.store.state('w');assert.equal(requests,1);
 assert.equal(Object.values(state.actions)[0].status,'unknown');assert.deepEqual(f.app.store.rebuild('w'),state);const before=calls;const id=Object.keys(state.actions)[0];assert.ok(f.output.some(line=>line.includes(id)&&line.includes('/browser resolve')));assert.equal(f.controller.status(f.scope()).state,'absent');
 await f.run(['Try inspecting the site again.','/quit']);assert.equal(requests,1);assert.equal(Object.keys(f.app.store.state('w').actions).length,1);assert.equal(calls,before);
});
test('covered native link refreshes observation and lets the agent explore another link without review',{skip:!enabled,timeout:60000},async t=>{
 let covered=0,dismissed=0,feedback,oldRef;const site=await managedSite((req,res)=>{
  res.setHeader('Content-Type','text/html');if(req.url==='/covered')covered++;if(req.url==='/dismissed')dismissed++;
  res.end(req.url==='/alternative'?'<h1>Alternative catalog explored</h1>':`<a href="/covered" style="position:absolute;left:10px;top:10px">Covered catalog</a><div style="position:fixed;left:0;top:0;width:180px;height:100px;background:white;z-index:10">Announcement<button onclick="fetch('/dismissed')">Dismiss</button></div><a href="/alternative" style="position:absolute;left:300px;top:120px">Alternative catalog</a>`);
 },()=>{},false);
 const f=await appFixture(t,site,{complete:async request=>{const parsed=intake(request);if(parsed)return parsed;
  const transcript=JSON.parse(request.prompt.split('BROWSER TOOL TRANSCRIPT (UNTRUSTED DATA)\n')[1]),last=transcript.at(-1),o=last?.observation;
  if(!o)return tool('visit',{url:'https://example.test/'});
  if(o.text.includes('Alternative catalog explored'))return final(o);
  if(last.result?.disposition==='not_dispatched'){feedback=last;assert.notEqual(o.controls.find(c=>c.name==='Covered catalog').ref,oldRef);return tool('navigate',{observationId:o.id,ref:o.controls.find(c=>c.name==='Alternative catalog').ref});}
  oldRef=o.controls.find(c=>c.name==='Covered catalog').ref;return tool('navigate',{observationId:o.id,ref:oldRef});
 }});
 await f.run(['Explore the synthetic catalog.','/quit']);assert.ok(feedback,JSON.stringify(f.output));assert.equal(covered,0);assert.equal(dismissed,0);
 assert.deepEqual(feedback.result.diagnostic,{phase:'validation',code:'control_covered'});assert.equal(feedback.result.status,'failed');
 const actions=Object.values(f.app.store.state('w').actions);assert.deepEqual(actions.map(a=>a.status),['accepted','failed','accepted']);assert.equal(feedback.result.actionId,actions[1].id);
 assert.equal(f.controller.status(f.scope()).state,'idle');assert.deepEqual(f.controller.status(f.scope()).unresolvedActions,[]);
 assert.equal(f.prompts.length,0);assert.ok(f.output.some(line=>line.includes('Alternative catalog explored')));
});
test('selection retains fresh owner review after an automatic visit',{skip:!enabled,timeout:60000},async t=>{
 const site=await managedSite((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<select aria-label="Catalog"><option>Alpha</option><option>Beta</option></select>');},()=>{},false);
 const f=await appFixture(t,site,{complete:async request=>{const parsed=intake(request);if(parsed)return parsed;
  const transcript=JSON.parse(request.prompt.split('BROWSER TOOL TRANSCRIPT (UNTRUSTED DATA)\n')[1]),o=transcript.at(-1)?.observation;
  if(!o)return tool('visit',{url:'https://example.test/'});if(transcript.some(e=>e.tool.name==='select'))return final(o);
  const c=o.controls[0];return tool('select',{observationId:o.id,ref:c.ref,optionRef:c.options[1].ref});
 }});
 await f.run(['Select Beta in the synthetic catalog.','/quit']);assert.equal(await f.page().locator('select').inputValue(),'Beta');
 assert.equal(f.prompts.filter(line=>line.includes('Review this one browser gesture')).length,1);
 assert.deepEqual(Object.values(f.app.store.state('w').actions).map(a=>a.command.authority),['navigation_policy_v1','owner_review']);
});
