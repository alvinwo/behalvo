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
async function appFixture(t,site,gateway){
 const dir=mkdtempSync(join(tmpdir(),'managed-acceptance-'));let controller,captured;const output=[];
 const io={interactive:true,discardSensitiveInput(){},readLine:async prompt=>prompt?.includes('Type resume')?'resume':'approve',write:line=>output.push(line)};
 const key=Buffer.alloc(32,7);const app=openLocalAgent({dbPath:join(dir,'agent.db'),encryptionKey:key,workspaceId:'w',ownerId:'o',taskContinuity:true,gateways:[{...gateway,listModels:async()=>[model]}],browser:{mode:'live',available:s=>controller?.available(s)??false,beforeTurn:s=>controller?.beforeTurn(s),open:(c,b)=>controller.exploration().open(c,b)}});
 controller=new ManagedBrowserController(app.store,(a,d,s)=>reviewBrowserGesture(io,a,d,s),{network:()=>site.gate,browser:options=>new LivePlaywright(options,{ignoreHTTPSErrors:true,loadChromium:async()=>({executablePath:()=>chromium.executablePath(),launchServer:options=>chromium.launchServer(options),connect:async(...args)=>{captured=await chromium.connect(...args);return captured;}})})});
 await app.registry.select(model.provider,model.model);
 const scope=()=>({workspaceId:'w',ownerId:'o',threadId:'chat',workId:Object.keys(app.store.state('w').works)[0]});
 const run=async steps=>runRepl({store:app.store,registry:app.registry,service:app.service,operations:app.operations,managedBrowser:controller,workspaceId:'w',ownerId:'o',initialThreadId:'chat',io:{...io,readPrompt:async()=>{const step=steps.shift();return typeof step==='function'?await step():step??null;}}});
 t.after(async()=>{assert.equal((await controller.shutdown()).confirmed,true);app.close();await site.close();rmSync(dir,{recursive:true,force:true});});
 return{app,controller,scope,run,output,dir,key,page:()=>captured.contexts()[0].pages()[0]};
}
for(const layout of ['directory','inventory'])test(`full chat and owner-review path on dynamic ${layout}`,{skip:!enabled,timeout:60000},async t=>{
 let searches=0;const site=await managedSite((req,res)=>{
  res.setHeader('Content-Type','text/html');
  if(req.url==='/search'){searches++;let body='';req.on('data',c=>body+=c);req.on('end',()=>{assert.match(body,/Cedar/);res.end('<h1>Cedar result</h1>');});return;}
  res.end(layout==='directory'?`<h1>Directory</h1><form action="/search" method="post"><label>Search<input name="q"></label><button>Find</button></form><script>document.querySelector('h1').textContent='Dynamic directory';</script>`:
   `<main><h2>Inventory lookup</h2><form action="/search" method="post"><textarea name="query" aria-label="Search"></textarea><input type="submit" aria-label="Find"></form></main>`);
 },()=>{},false);
 const f=await appFixture(t,site,{complete:async request=>{const extracted=intake(request);if(extracted)return extracted;
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
 assert.equal(Object.values(state.actions).filter(a=>a.status==='accepted').length,3);assert.ok(Object.keys(state.browserMemory.notes).length);assert.ok(Object.keys(state.taskContinuity.progress).length);
 assert.equal(f.controller.status(f.scope()).state,'idle');assert.deepEqual(f.app.store.rebuild('w'),state);
 await f.app.store.backup(join(f.dir,'backup'));assert.equal(searches,1);assert.equal(readFileSync(join(f.dir,'agent.db')).includes(Buffer.from('Cedar result')),false);
});
test('lost mutation response is unknown once, survives replay, and blocks a new browser until owner reconciliation',{skip:!enabled,timeout:60000},async t=>{
 let effects=0;const site=await managedSite((req,res)=>{if(req.url==='/change'){effects++;req.socket.destroy();return;}res.setHeader('Content-Type','text/html');res.end('<h1>Unknown outcome fixture</h1><form method="post" action="/change"><button>Apply</button></form>');},()=>{},false);
 const f=await appFixture(t,site,{complete:async request=>{const parsed=intake(request);if(parsed)return parsed;if(!request.prompt.includes('BROWSER TOOL TRANSCRIPT'))return{text:JSON.stringify({reply:'Ready',workProposals:[],factProposals:[]})};
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
  if(!request.prompt.includes('BROWSER TOOL TRANSCRIPT'))return{text:JSON.stringify({reply:'Ready',workProposals:[],factProposals:[]})};
  const o=JSON.parse(request.prompt.split('BROWSER TOOL TRANSCRIPT (UNTRUSTED DATA)\n')[1]).at(-1)?.observation;return o?{text:JSON.stringify({reply:o.text,notes:[]})}:tool('observe');
 }});
 await f.run(['Inspect a synthetic login page.','/browser open https://example.test/','/browser handoff','/quit']);const before=calls;
 await f.run(['Continue.','/quit']);assert.equal(calls,before);
 await f.page().getByLabel('Username').fill('synthetic-user');await f.page().getByLabel('Password').fill('PRIVATE_SYNTHETIC_PASSWORD');await f.page().getByRole('button',{name:'Sign in'}).click();
 await f.run(['/browser resume','Inspect the signed-in page.','Inspect again.','/quit']);assert.ok(f.output.some(line=>line.includes('Signed in synthetic account')));assert.equal(f.controller.status(f.scope()).state,'idle');
 assert.equal(Object.keys(f.app.store.state('w').actions).length,1);
});
