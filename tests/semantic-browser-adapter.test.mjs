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
  try{const o=await p.observe({...scope,execution:{deadline:Date.now()+10000},assertCurrent(){},resolveInput(){throw new Error('Denied');}});const c=o.controls.find(c=>c.name===trap);await assert.rejects(()=>p.interact({...scope,execution:{deadline:Date.now()+10000},assertCurrent(){},resolveInput(){throw new Error('Denied');}},{kind:'navigate',observationId:o.id,ref:c.ref}));assert.equal(f.counters.effects,0);}finally{assert.equal((await p.close()).confirmed,true);await f.close();}
 }
});
