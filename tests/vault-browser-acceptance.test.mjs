import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {LocalCredentialVault,VaultLoginBroker} from '../dist/index.js';
import {SqliteStore} from '../dist/storage/sqlite-store.js';
import {Operator} from '../dist/runtime/operator.js';
import {runBrowserExploration} from '../dist/runtime/browser-exploration.js';
const enabled=process.env.BEHALVO_VAULT_ACCEPTANCE==='1';
test('visible vault login captures privately, reopens encrypted storage and asks again',{skip:!enabled,timeout:60000},async()=>{
 const fixtureModule=await import('../dist/browser/synthetic-login-fixture.js').catch(()=>({}));assert.equal(typeof fixtureModule.startSyntheticLoginFixture,'function');
 const {SyntheticLoginBrowser}=await import('../dist/browser/synthetic-login-browser.js');
 const root=mkdtempSync(join(tmpdir(),'vault-visible-'));const key=Buffer.alloc(32,41);const path=join(root,'vault');const make=()=>new LocalCredentialVault({path,loadKey:()=>Buffer.from(key)});let vault=make();
 const username='SYNTHETIC-VISIBLE-USERNAME',password='SYNTHETIC-VISIBLE-PASSWORD';const fixture=await fixtureModule.startSyntheticLoginFixture({username,password});
 const scope={workspaceId:'w',ownerId:'o'};const outputs=[];
 try{
  await vault.initialize(scope);
  for(let round=0;round<2;round++){
   if(round){vault.lock();vault=make();await vault.unlock();}
   const answers=round?['yes']:['yes','Visible test account'];const secrets=[username,password];const io={interactive:true,readLine:async()=>answers.shift()??null,readSecret:async()=>secrets.shift()??null,discardSensitiveInput(){},write:x=>outputs.push(x)};
   const broker=new VaultLoginBroker({vault,io});const controller=new AbortController();const port=new SyntheticLoginBrowser(fixture.authority,controller.signal);
   const ctx={workspaceId:'w',workId:'task',workRevision:1,sessionId:`session-${round}`,generation:1,execution:{deadline:Date.now()+20000,signal:controller.signal},assertCurrent(){},resolveInput(){throw Error('denied');},login:(challenge,use,checkBrowser)=>broker.use(scope,{...challenge,ownerId:'o'}, {deadline:Date.now()+15000,signal:controller.signal,assertCurrent:()=>{ctx.assertCurrent();checkBrowser();}},use,fixture.authority.secretAuthority)};
   try{const first=await port.observe(ctx);assert.equal(first.controls.length,1);const result=await port.interact(ctx,{kind:'request_login',observationId:first.id,ref:first.controls[0].ref});outputs.push(JSON.stringify(result));assert.match(result.text,/verified/);assert.deepEqual(result.controls,[]);await assert.rejects(()=>port.observe(ctx));assert.equal((await port.close()).confirmed,true);}finally{await port.close();}
  }
  assert.equal(fixture.counters.attempts,2);assert.equal(fixture.counters.forbidden,0);
  assert.doesNotMatch(outputs.join('\n')+readFileSync(path,'utf8'),/SYNTHETIC-VISIBLE-(?:USERNAME|PASSWORD)/);
 }finally{vault.lock();await fixture.close();rmSync(root,{recursive:true,force:true});}
});

test('visible login enforces live authority, exact form and terminal outcome',{skip:!enabled,timeout:120000},async t=>{
 const {startSyntheticLoginFixture}=await import('../dist/browser/synthetic-login-fixture.js');
 const {SyntheticLoginBrowser}=await import('../dist/browser/synthetic-login-browser.js');
 const {chromium}=await import('playwright');
 const root=mkdtempSync(join(tmpdir(),'vault-guards-'));const vault=new LocalCredentialVault({path:join(root,'vault'),loadKey:()=>Buffer.alloc(32,42)});
 const scope={workspaceId:'w',ownerId:'o'}, username='SYNTHETIC-GUARD-USER',password='SYNTHETIC-GUARD-PASS';
 const fixture=await startSyntheticLoginFixture({username,password});
 try{
  await assert.rejects(()=>startSyntheticLoginFixture());
  assert.throws(()=>new SyntheticLoginBrowser({...fixture.authority},new AbortController().signal));
  await vault.initialize(scope);
  for(const mode of ['target','action','extra-field','document','task-revision','vault-lock','entry-removed','request-revoked','response-unknown','cleanup-unconfirmed'])await t.test(mode,async()=>{
   if(!vault.isUnlocked)await vault.unlock();
   let entry=(await vault.list(scope))[0];
   if(!entry)entry=await vault.add(scope,{label:'Guard account',origin:fixture.authority.origin,username:Buffer.from(username),password:Buffer.from(password)},{assertCurrent(){}},fixture.authority.secretAuthority);
   let page,current=true;const controller=new AbortController();
   const dependencies={loadChromium:async()=>({executablePath:()=>chromium.executablePath(),launchServer:options=>chromium.launchServer(options),connect:async(...args)=>{
    const browser=await chromium.connect(...args);const create=browser.newContext.bind(browser);
    browser.newContext=async options=>{const context=await create(options);context.on('page',p=>page=p);
     const route=context.route.bind(context);context.route=async(pattern,handler)=>route(pattern,async r=>{
      if(r.request().method()==='POST'&&mode==='request-revoked')current=false;
      if(r.request().method()==='POST'&&mode==='response-unknown'){
       const fulfill=r.fulfill.bind(r);r.fulfill=options=>fulfill({...options,body:'<html><body>Unrecognized synthetic response</body></html>'});
      }
      return handler(r);
     });return context;};return browser;
   }})};
   const io={interactive:true,discardSensitiveInput(){},write(){},readSecret:async()=>{throw Error('Unexpected capture');},readLine:async()=>{
    if(mode==='target')await page.evaluate(()=>document.forms[0].target='_blank');
    if(mode==='action')await page.evaluate(()=>document.forms[0].action='https://foreign.example/login');
    if(mode==='extra-field')await page.evaluate(()=>{const el=document.createElement('input');el.name='copy';document.forms[0].append(el);});
    if(mode==='document')await page.goto('about:blank');
    if(mode==='task-revision')current=false;
    if(mode==='vault-lock')vault.lock();
    if(mode==='entry-removed')await vault.remove(scope,entry.id,entry.revision);
    return 'yes';
   }};
   const broker=new VaultLoginBroker({vault,io});const port=new SyntheticLoginBrowser(fixture.authority,controller.signal,dependencies);
   if(mode==='cleanup-unconfirmed'){const close=port.close.bind(port);port.close=async()=>{await close();return{confirmed:false};};}
   const ctx={workspaceId:'w',workId:'task',workRevision:1,sessionId:mode,generation:1,execution:{deadline:Date.now()+15000,signal:controller.signal},assertCurrent(){if(!current)throw Error(password);},resolveInput(){throw Error('No inputs');},login:(challenge,use,checkBrowser)=>broker.use(scope,{...challenge,ownerId:'o'},{deadline:Date.now()+12000,signal:controller.signal,assertCurrent(){ctx.assertCurrent();checkBrowser();}},use,fixture.authority.secretAuthority)};
   const before=fixture.counters.attempts;
   try{
    const first=await port.observe(ctx);const result=await port.interact(ctx,{kind:'request_login',observationId:first.id,ref:first.controls[0].ref});
    const dispatched=['response-unknown','cleanup-unconfirmed'].includes(mode);
    assert.equal(fixture.counters.attempts-before,dispatched?1:0);
    assert.match(result.text,dispatched?/unknown|unconfirmed/:/stopped before dispatch/);
    assert.deepEqual(result.controls,[]);assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC-GUARD/);
    await assert.rejects(()=>port.interact(ctx,{kind:'request_login',observationId:first.id,ref:first.controls[0].ref}));
   }finally{await port.close();}
  });
  assert.equal(fixture.counters.forbidden,0);
 }finally{vault.lock();await fixture.close();rmSync(root,{recursive:true,force:true});}
});

test('actual browser login keeps canaries out of model requests, journal and artifacts',{skip:!enabled,timeout:30000},async()=>{
 const {startSyntheticLoginFixture}=await import('../dist/browser/synthetic-login-fixture.js');
 const {SyntheticLoginBrowser}=await import('../dist/browser/synthetic-login-browser.js');
 const root=mkdtempSync(join(tmpdir(),'vault-runtime-')),path=join(root,'vault');
 const vault=new LocalCredentialVault({path,loadKey:()=>Buffer.alloc(32,43)}),scope={workspaceId:'w',ownerId:'o'};
 const fixture=await startSyntheticLoginFixture({username:'RUNTIME-USER-CANARY',password:'RUNTIME-PASS-CANARY'});
 const store=new SqliteStore(':memory:');store.createWorkspace('w','o');new Operator(store).createWork('w','o',{id:'task',title:'Synthetic login',goal:'Sign in',threadId:'t'});
 const record=store.ingest('w',{source:'owner',externalId:'owner',threadId:'t',senderId:'o',senderRole:'owner',text:'Sign in to the synthetic account.'});
 const binding={...scope,workId:'task',expectedWorkRevision:1,ownerRecordId:record.id};
 const captured=[],answers=['yes','Runtime account'],secrets=['RUNTIME-USER-CANARY','RUNTIME-PASS-CANARY'];
 const io={interactive:true,readLine:async prompt=>{captured.push(prompt);return answers.shift()??null;},readSecret:async prompt=>{captured.push(prompt);return secrets.shift()??null;},discardSensitiveInput(){},write:x=>captured.push(x)};
 let calls=0,latest;
 const gateway={complete:async request=>{captured.push(request);calls++;
  if(calls===1)return{text:JSON.stringify({tool:{name:'observe',arguments:{}}})};
  if(calls===2)return{text:JSON.stringify({tool:{name:'request_login',arguments:{observationId:latest.id,ref:latest.controls[0].ref}}})};
  assert.match(request.prompt,/Synthetic login verified/);return{text:JSON.stringify({reply:'Synthetic sign-in verified; browser closed.',notes:[]})};
 }};
 try{
  await vault.initialize(scope);
  const options={open:async ctx=>{const port=new SyntheticLoginBrowser(fixture.authority,ctx.execution.signal??new AbortController().signal);const observe=port.observe.bind(port);port.observe=async c=>latest=await observe(c);return port;},login:(b,c,e,use)=>new VaultLoginBroker({vault,io}).use({workspaceId:b.workspaceId,ownerId:b.ownerId},c,e,use,fixture.authority.secretAuthority)};
  const result=await runBrowserExploration(store,gateway,{system:'',prompt:'Synthetic owner task'},binding,{deadline:Date.now()+20000},options,8,196608,[]);
  assert.equal(result.applicationAuthored,false);assert.equal(result.cleanupConfirmed,true);assert.equal(fixture.counters.attempts,1);
  assert.deepEqual(store.rebuild('w'),store.state('w'));
  const records=store.journal('w');
  const artifacts=records.flatMap(r=>r.event.type==='browser.observed'?[store.readArtifact('w',r.event.data.source.artifactId)]:r.event.type==='message.received'?[store.readArtifact('w',r.event.data.artifactId)]:[]);
  assert.equal(artifacts.length,3);
  assert.doesNotMatch(JSON.stringify({captured,result,records,artifacts,state:store.state('w'),replayed:store.rebuild('w')})+readFileSync(path,'utf8'),/RUNTIME-(?:USER|PASS)-CANARY/);
 }finally{store.close();vault.lock();await fixture.close();rmSync(root,{recursive:true,force:true});}
});
