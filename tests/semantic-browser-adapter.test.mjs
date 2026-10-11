import test from 'node:test';
import assert from 'node:assert/strict';
const scope={workspaceId:'w',workId:'task',workRevision:1,sessionId:'s',generation:1};
test('fixture policy denies mutating GET, foreign origins, arbitrary queries and unknown field purposes',async()=>{
 const {requestAllowed,fieldPurpose}=await import('../dist/browser/semantic-fixture-policy.js');
 const policy={origin:'http://127.0.0.1:43117',routes:[{path:'/',query:{}},{path:'/search',query:{period:['morning','afternoon']}}],fields:[{path:'/',name:'period',purpose:'session-period'}]};
 assert.equal(requestAllowed(policy,'GET',policy.origin+'/'),true);
 for(const [method,url] of [['POST',policy.origin+'/'],['GET',policy.origin+'/book'],['GET','http://127.0.0.1:43118/'],['GET',policy.origin+'/search?period=CANARY'],['GET',policy.origin+'/search?period=morning&period=afternoon']])assert.equal(requestAllowed(policy,method,url),false);
 assert.equal(fieldPurpose(policy,'/','period'),'session-period');assert.throws(()=>fieldPurpose(policy,'/','password'));
});
const enabled=process.env.BEHALVO_SEMANTIC_ACCEPTANCE==='1';
for(const site of ['appointments-a','appointments-b','classes'])test(`visible semantic adapter explores ${site} with current refs and zero forbidden requests`,{skip:!enabled,timeout:30000},async()=>{
 const {startSemanticFixture}=await import('../dist/browser/semantic-fixture-sites.js');const {SemanticPlaywright}=await import('../dist/browser/semantic-playwright.js');
 const fixture=await startSemanticFixture(site);const controller=new AbortController();const port=new SemanticPlaywright(fixture.policy,controller.signal);
 const ctx={...scope,execution:{deadline:Date.now()+25000,signal:controller.signal},assertCurrent(){},resolveInput(){throw new Error('No input authorization');}};
 try{
  const first=await port.observe(ctx);assert.equal(first.origin,fixture.policy.origin);assert.ok(first.controls.length);
  const bad=first.controls.find(c=>c.name==='Book now');await assert.rejects(()=>port.interact(ctx,{kind:'navigate',observationId:first.id,ref:bad.ref}));assert.equal(fixture.counters.effects,0);
  const good=first.controls.find(c=>c.name==='Browse sessions');const next=await port.interact(ctx,{kind:'navigate',observationId:first.id,ref:good.ref});assert.match(next.text,/morning|afternoon/);
  await assert.rejects(()=>port.interact(ctx,{kind:'navigate',observationId:first.id,ref:good.ref}));assert.equal(fixture.counters.effects,0);
 }finally{assert.equal((await port.close()).confirmed,true);await fixture.close();}
});
test('visible input and request traps reject disclosure and redirects before any effect', {skip:!enabled,timeout:30000},async()=>{
 const {startSemanticFixture}=await import('../dist/browser/semantic-fixture-sites.js');const {SemanticPlaywright}=await import('../dist/browser/semantic-playwright.js');const fixture=await startSemanticFixture('classes');
 const controller=new AbortController();let authorized=false;const port=new SemanticPlaywright(fixture.policy,controller.signal);const ctx={...scope,execution:{deadline:Date.now()+25000,signal:controller.signal},assertCurrent(){},resolveInput(id,origin,purpose){assert.equal(id,'input');assert.equal(origin,fixture.policy.origin);assert.equal(purpose,'session-period');if(!authorized)throw new Error('Denied');return 'morning';}};
 try{
  let o=await port.observe(ctx);assert.ok(!o.controls.some(c=>/Password|SYNTHETIC_SECRET/.test(c.name)));
  const input=o.controls.find(c=>c.role==='textbox');const count=fixture.counters.requests;await assert.rejects(()=>port.interact(ctx,{kind:'fill',observationId:o.id,ref:input.ref,taskInputId:'input'}));assert.equal(fixture.counters.requests,count);
  const popup=o.controls.find(c=>c.name==='Popup trap');await assert.rejects(()=>port.interact(ctx,{kind:'navigate',observationId:o.id,ref:popup.ref}));assert.equal(fixture.counters.requests,count);
  authorized=true;o=await port.interact(ctx,{kind:'fill',observationId:o.id,ref:input.ref,taskInputId:'input'});authorized=false;
  const submit=o.controls.find(c=>c.name==='Search');await assert.rejects(()=>port.interact(ctx,{kind:'click',observationId:o.id,ref:submit.ref}));assert.equal(fixture.counters.requests,count);
  authorized=true;o=await port.interact(ctx,{kind:'click',observationId:o.id,ref:submit.ref});assert.match(o.text,/morning/);assert.equal(fixture.counters.effects,0);
  controller.abort();await assert.rejects(()=>port.observe(ctx));
 }finally{assert.equal((await port.close()).confirmed,true);await fixture.close();}
 for(const trap of ['Redirect trap','Download trap']){
  const f=await startSemanticFixture('classes');const p=new SemanticPlaywright(f.policy,new AbortController().signal);
  try{const o=await p.observe({...scope,execution:{deadline:Date.now()+10000},assertCurrent(){},resolveInput(){throw new Error('Denied');}});const c=o.controls.find(c=>c.name===trap);const count=f.counters.requests;await assert.rejects(()=>p.interact({...scope,execution:{deadline:Date.now()+10000},assertCurrent(){},resolveInput(){throw new Error('Denied');}},{kind:'navigate',observationId:o.id,ref:c.ref}));assert.equal(f.counters.effects,0);assert.equal(f.counters.requests,count);}finally{assert.equal((await p.close()).confirmed,true);await f.close();}
 }
});
for(const mode of ['revoke-before-request','document-after-target','document-during-observation'])test(`visible race ${mode} stops before stale disclosure/observation`,{skip:!enabled,timeout:25000},async()=>{
 const {startSemanticFixture}=await import('../dist/browser/semantic-fixture-sites.js');const {SemanticPlaywright}=await import('../dist/browser/semantic-playwright.js');const {chromium}=await import('playwright');const f=await startSemanticFixture('classes');let page,armed=false,authorized=true;
 const dependencies={loadChromium:async()=>({executablePath:()=>chromium.executablePath(),launchServer:options=>chromium.launchServer(options),connect:async(...args)=>{const browser=await chromium.connect(...args);const create=browser.newContext.bind(browser);browser.newContext=async options=>{const context=await create(options);context.on('page',p=>{
  page=p;const go=p.goto.bind(p);p.goto=async(url,options)=>{if(armed&&mode==='revoke-before-request'&&url.includes('/search'))authorized=false;return go(url,options);};
  const query=p.$$.bind(p);p.$$=async selector=>{const handles=await query(selector);for(const handle of handles){const evaluate=handle.evaluate.bind(handle);handle.evaluate=async(...args)=>{const value=await evaluate(...args);if(armed&&mode==='document-after-target'&&value?.url){armed=false;await go('about:blank');}return value;};}return handles;};
  const locator=p.locator.bind(p);p.locator=(...args)=>{const l=locator(...args);if(args[0]==='body'){const read=l.innerText.bind(l);l.innerText=async(...args)=>{const text=await read(...args);if(armed&&mode==='document-during-observation'){armed=false;await go('about:blank');}return text;};}return l;};
 });return context;};return browser;}})};
 const controller=new AbortController();const p=new SemanticPlaywright(f.policy,controller.signal,dependencies);const ctx={...scope,execution:{deadline:Date.now()+20000,signal:controller.signal},assertCurrent(){},resolveInput(){if(!authorized)throw new Error('Revoked');return 'morning';}};
 try{
  let o=await p.observe(ctx);assert.ok(page);
  if(mode==='revoke-before-request'){const input=o.controls.find(c=>c.role==='textbox');o=await p.interact(ctx,{kind:'fill',observationId:o.id,ref:input.ref,taskInputId:'input'});}
  const before=f.counters.requests;armed=true;
  if(mode==='document-during-observation')await assert.rejects(()=>p.observe(ctx));
  else {const c=o.controls.find(c=>c.name===(mode==='revoke-before-request'?'Search':'Browse sessions'));await assert.rejects(()=>p.interact(ctx,{kind:mode==='revoke-before-request'?'click':'navigate',observationId:o.id,ref:c.ref}));}
  assert.equal(f.counters.requests,before);assert.equal(f.counters.effects,0);
 }finally{assert.equal((await p.close()).confirmed,true);await f.close();}
});
test('visible selection accepts only current option references and a reviewed filter request',{skip:!enabled,timeout:20000},async()=>{
 const {startSemanticFixture}=await import('../dist/browser/semantic-fixture-sites.js');const {SemanticPlaywright}=await import('../dist/browser/semantic-playwright.js');const f=await startSemanticFixture('classes');const p=new SemanticPlaywright(f.policy,new AbortController().signal);const ctx={...scope,execution:{deadline:Date.now()+15000},assertCurrent(){},resolveInput(){throw new Error('No typed input');}};
 try{let o=await p.observe(ctx);const select=o.controls.find(c=>c.role==='combobox');assert.ok(select);await assert.rejects(()=>p.interact(ctx,{kind:'select',observationId:o.id,ref:select.ref,optionRef:'forged'}));o=await p.interact(ctx,{kind:'select',observationId:o.id,ref:select.ref,optionRef:select.options.find(x=>x.name==='Afternoon').ref});const button=o.controls.find(c=>c.name==='Filter');o=await p.interact(ctx,{kind:'click',observationId:o.id,ref:button.ref});assert.equal(o.location,'/filter');assert.equal(f.counters.effects,0);}finally{assert.equal((await p.close()).confirmed,true);await f.close();}
});
