import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { LivePlaywright } from '../dist/browser/live-playwright.js';
import { managedSite } from './helpers/managed-site.mjs';

const enabled = process.env.BEHALVO_MANAGED_ACCEPTANCE === '1';
function lease(generation = 1) { return { workspaceId: 'w', workId: 'task', workRevision: 1, sessionId: 'session', generation,
  execution: { deadline: Date.now() + 30000, signal: new AbortController().signal }, assertCurrent() {}, resolveInput() { return 'Cedar'; } }; }
async function direct(context, command, detail, gesture) {
  await gesture.validate(); return { actionId: 'test', status: 'accepted', observation: await gesture.dispatch(() => gesture.assertCurrent()) };
}
test('explicit visits reuse the page and cookies but expire refs and input authority even for fragments',{skip:!enabled,timeout:60000},async()=>{
 const visits=[];const site=await managedSite((req,res)=>{res.setHeader('Content-Type','text/html');if(req.url==='/')res.setHeader('Set-Cookie','session=synthetic;Secure;HttpOnly');res.end(`<h1>${req.headers.cookie?.includes('session=synthetic')?'Retained':'Initial'}</h1><label>Search<input name="q"></label><a href="/next">Continue</a>`);});
 const live=new LivePlaywright({sessionId:'session',threadId:'thread',network:site.gate,assertSession(){},perform:async(ctx,command,detail,gesture)=>{visits.push({command,detail});return direct(ctx,command,detail,gesture);}},{ignoreHTTPSErrors:true});
 try{const ctx=lease();let o=await live.visit(ctx,'https://example.test/');const old=o,field=live.inputs()[0],purpose=live.inputPurpose(field.ref);
  o=await live.visit(ctx,'https://example.test/#section');assert.throws(()=>live.inputPurpose(field.ref));assert.notEqual(live.inputPurpose(live.inputs()[0].ref),purpose);
  await assert.rejects(live.interact(ctx,{kind:'navigate',observationId:old.id,ref:old.controls.find(c=>c.name==='Continue').ref}));
  await live.retire();o=await live.visit(lease(2),'https://example.test/next');assert.match(o.text,/Retained/);
  assert.ok(visits.every(v=>v.command.operation==='visit'));assert.equal(visits[1].detail.destination,'https://example.test/#section');assert.equal(visits.length,3);
 }finally{assert.equal((await live.close()).confirmed,true);await site.close();}
});
for(const decision of ['reject','handoff'])test(`initial visit ${decision} sends no destination traffic`,{skip:!enabled,timeout:60000},async()=>{
 const site=await managedSite((_req,res)=>res.end('Must not load'));let reviews=0;
 const live=new LivePlaywright({sessionId:'session',threadId:'thread',network:site.gate,assertSession(){},perform:async(_ctx,command,detail,gesture)=>{assert.equal(command.operation,'visit');assert.equal(detail.destination,'https://example.test/');await gesture.validate();reviews++;return {actionId:'test',status:decision};}},{ignoreHTTPSErrors:true});
 try{await assert.rejects(live.visit(lease(),'https://example.test/'));assert.equal(reviews,1);assert.equal(site.requests.length,0);assert.equal(live.human,decision==='handoff');}
 finally{assert.equal((await live.close()).confirmed,true);await site.close();}
});
test('public cross-origin scripts, content APIs, images and redirects render without origin enrollment',{skip:!enabled,timeout:60000},async()=>{
 const site=await managedSite((req,res)=>{
  if(req.url==='/content'){res.setHeader('Access-Control-Allow-Origin','*');return res.end('Public content loaded');}
  if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript');return res.end(`fetch('https://content.test/content').then(r=>r.text()).then(text=>document.querySelector('h1').textContent=text);`);}
  if(req.url==='/style.css'){res.setHeader('Content-Type','text/css');return res.end('h1 { color: green; }');}
  if(req.url==='/image.svg'){res.setHeader('Content-Type','image/svg+xml');return res.end('<svg xmlns="http://www.w3.org/2000/svg"/>');}
  if(req.url==='/redirect'){res.writeHead(302,{location:'https://destination.test/landed'});return res.end();}
  res.setHeader('Content-Type','text/html');
  if(req.url==='/landed')return res.end('<h1>Public destination</h1>');
  res.end('<h1>Loading</h1><link rel="stylesheet" href="https://styles.test/style.css"><script src="https://scripts.test/app.js"></script><img src="https://images.test/image.svg"><a href="/redirect">Continue</a>');
 });
 const live=new LivePlaywright({sessionId:'session',threadId:'thread',network:site.gate,assertSession(){},perform:direct},{ignoreHTTPSErrors:true});
 try{
  const ctx=lease();let o=await live.open(ctx,'https://example.test/');
  for(let i=0;i<20&&!o.text.includes('Public content loaded');i++){await new Promise(r=>setTimeout(r,50));o=await live.observe(ctx);}
  assert.match(o.text,/Public content loaded/);
  for(const path of ['/app.js','/content','/style.css','/image.svg'])assert.ok(site.requests.some(r=>r.url===path),path);
  o=await live.interact(ctx,{kind:'navigate',observationId:o.id,ref:o.controls.find(c=>c.name==='Continue').ref});
  assert.equal(o.origin,'https://destination.test');assert.match(o.text,/Public destination/);
 }finally{assert.equal((await live.close()).confirmed,true);await site.close();}
});
test('generic live pages execute JS, keep cookies, expose safe controls and require fresh refs and field matches', { skip: !enabled, timeout: 60000 }, async () => {
  const site = await managedSite((req, res) => {
    if (req.url === '/app.js') return res.end(`document.querySelector('h1').textContent='Dynamic directory';document.cookie='session=synthetic;Secure';`);
    if (req.url === '/search') return res.end('<h1>Results Cedar</h1>');
    if (req.url === '/cookie') return res.end('<h1>' + (req.headers.cookie?.includes('session=synthetic') ? 'Retained session' : 'No session') + '</h1>');
    res.setHeader('Content-Type', 'text/html'); res.end(`<h1>Loading</h1><script src="/app.js"></script><form action="/search" method="post"><label>Search<input name="query"></label><button>Find</button></form>
      <label>Password<input type="password" value="NEVER_EXPOSE"></label><label>OTP<input autocomplete="one-time-code" value="SECRET_CODE"></label><textarea aria-label="Notes">PRIVATE_TEXTAREA</textarea>
      <label><input type="checkbox" name="morning">Morning</label><select aria-label="City"><option value="a">Alpha</option><option value="b">Beta</option></select>
      <a href="/cookie">Cookie check</a><a href="/redirect">Redirect</a><button onclick="document.querySelector('input[name=query]').outerHTML='<input aria-label=Changed name=query>'">Replace field</button>`);
  });
  const live = new LivePlaywright({ sessionId: 'session', threadId: 'thread', network: site.gate, assertSession() {}, perform: direct }, { ignoreHTTPSErrors: true });
  const ctx = lease();
  try {
    let o = await live.open(ctx, 'https://example.test/');
    assert.match(o.text, /Dynamic directory/); assert.doesNotMatch(JSON.stringify(o), /NEVER_EXPOSE|SECRET_CODE|PRIVATE_TEXTAREA/);
    assert.ok(!o.controls.some(c => /Password|OTP/.test(c.name)));
    const field = o.controls.find(c => c.name === 'Search'); assert.ok(field);
    const catalog = live.inputs(); const input = catalog.find(c => c.name === 'Search'); assert.ok(input); const purpose = live.inputPurpose(input.ref);
    const previous = { kind: 'fill', observationId: o.id, ref: field.ref, taskInputId: 'input' };
    await live.retire(); const next = lease(2);
    await assert.rejects(live.interact(next, previous));
    o = await live.observe(next); assert.equal(live.inputPurpose(input.ref), purpose);
    o = await live.interact(next, { kind: 'fill', observationId: o.id, ref: o.controls.find(c => c.name === 'Search').ref, taskInputId: 'input' });
    assert.ok(site.requests.some(r => r.url === '/app.js'));
    const check = o.controls.find(c => c.name.includes('Morning'));
    o = await live.interact(next, { kind: 'click', observationId: o.id, ref: check.ref }); assert.ok(o.controls.some(c => c.name.includes('checked')));
    o = await live.interact(next, { kind: 'navigate', observationId: o.id, ref: o.controls.find(c => c.name === 'Cookie check').ref });
    assert.match(o.text, /Retained session/); assert.throws(() => live.inputPurpose(input.ref));
    await live.handoff(); await assert.rejects(live.observe(next)); await live.resume();
  } finally { assert.equal((await live.close()).confirmed, true); assert.equal(existsSync(live.receiptPath), false); await site.close(); }
});

test('route guard denies private redirects, popup, WebSocket and service worker traffic', { skip: !enabled, timeout: 60000 }, async () => {
  const site = await managedSite((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: 'https://127.0.0.1/forbidden' }); return res.end(); }
    res.setHeader('Content-Type', 'text/html');res.end(`<h1>Boundary</h1><script>new WebSocket('wss://example.test/ws');navigator.serviceWorker.register('/sw.js').catch(()=>{});window.open('/popup');fetch('https://127.0.0.1/foreign').catch(()=>{});</script><a href="/redirect">Redirect</a>`);
  });
  const live = new LivePlaywright({ sessionId: 'session', threadId: 'thread', network: site.gate, assertSession() {}, perform: direct }, { ignoreHTTPSErrors: true });
  try {
    const ctx = lease();const o = await live.open(ctx, 'https://example.test/');
    await assert.rejects(live.interact(ctx, { kind: 'navigate', observationId: o.id, ref: o.controls[0].ref }));
    assert.ok(!site.requests.some(r => /forbidden|foreign|sw.js|ws|popup/.test(r.url)));
  } finally { assert.equal((await live.close()).confirmed, true); await site.close(); }
});

test('public navigation cannot reuse an owner input authorized for another origin',{skip:!enabled,timeout:60000},async t=>{
 const {fixture,createWork,message}=await import('./helpers.mjs');
 const {authorizeTaskInput,resolveStoredTaskInput}=await import('../dist/runtime/browser-learning.js');
 const f=await fixture(t);createWork(f);const source=f.store.ingest('personal',message('input',{text:'Cedar'}));
 const binding={workspaceId:'personal',ownerId:'owner',workId:'w',ownerRecordId:source.id,expectedWorkRevision:1};
 let fills=0;
 const site=await managedSite((req,res)=>{if(req.url==='/filled'){fills++;return res.end('ok');}res.setHeader('Content-Type','text/html');res.end('<label>Search<input name="q" oninput="fetch(\'/filled\')"></label><a href="https://other.test/">Other site</a>');});
 const live=new LivePlaywright({sessionId:'session',threadId:'im',network:site.gate,assertSession(){},perform:direct},{ignoreHTTPSErrors:true});
 try{
  const ctx={...lease(),workspaceId:'personal',workId:'w',resolveInput:(id,origin,purpose)=>resolveStoredTaskInput(f.store,binding,id,origin,purpose)};
  let o=await live.open(ctx,'https://example.test/');const field=live.inputs()[0],purpose=live.inputPurpose(field.ref);
  const input=authorizeTaskInput(f.store,binding,{quote:'Cedar',origin:field.origin,purpose},true);
  o=await live.interact(ctx,{kind:'fill',observationId:o.id,ref:o.controls.find(c=>c.name==='Search').ref,taskInputId:input.id});
  for(let i=0;i<20&&fills===0;i++)await new Promise(r=>setTimeout(r,25));assert.equal(fills,1);
  o=await live.interact(ctx,{kind:'navigate',observationId:o.id,ref:o.controls.find(c=>c.name==='Other site').ref});
  assert.equal(o.origin,'https://other.test');assert.throws(()=>live.inputPurpose(field.ref));
  await assert.rejects(live.interact(ctx,{kind:'fill',observationId:o.id,ref:o.controls.find(c=>c.name==='Search').ref,taskInputId:input.id}));
  assert.equal(fills,1);
 }finally{assert.equal((await live.close()).confirmed,true);await site.close();}
});

test('a replaced control during review cannot receive an authorized value', { skip: !enabled, timeout: 60000 }, async () => {
  let replacing=false,dispatched=0;
  const replacement=await managedSite((req,res)=>{res.setHeader('Content-Type','text/html');if(req.url==='/state')return res.end(replacing?'replace':'same');res.end(`<label>Query<input name="q"></label><script>setInterval(async()=>{if(await (await fetch('/state')).text()==='replace')document.querySelector('input').outerHTML='<input aria-label=Replacement name=q>';},25)</script>`);});
  const mutate=async(context,command,detail,gesture)=>{
    await gesture.validate();
    if(command.operation==='interact'){replacing=true;await new Promise(resolve=>setTimeout(resolve,150));await gesture.validate();}
    return {actionId:'test',status:'accepted',observation:await gesture.dispatch(()=>{gesture.assertCurrent();dispatched++;})};
  };
  const live=new LivePlaywright({sessionId:'session',threadId:'thread',network:replacement.gate,assertSession(){},perform:mutate},{ignoreHTTPSErrors:true});
  try{const ctx=lease();const o=await live.open(ctx,'https://example.test/');
    await assert.rejects(live.interact(ctx,{kind:'fill',observationId:o.id,ref:o.controls[0].ref,taskInputId:'authorized'}));assert.equal(dispatched,1);
    await live.handoff();assert.deepEqual(live.inputs(),[]);
  }finally{assert.equal((await live.close()).confirmed,true);await replacement.close();}
});
test('duplicate semantic fields and a handoff epoch never recover prior input authority',{skip:!enabled,timeout:60000},async()=>{
 let duplicate=false;const site=await managedSite((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<label>Search<input name="q"></label>'+(duplicate?'<label>Search<input name="q"></label>':''));});
 const live=new LivePlaywright({sessionId:'session',threadId:'thread',network:site.gate,assertSession(){},perform:direct},{ignoreHTTPSErrors:true});
 try{const ctx=lease();await live.open(ctx,'https://example.test/');const old=live.inputs()[0],purpose=live.inputPurpose(old.ref);await live.handoff();await live.resume();assert.throws(()=>live.inputPurpose(old.ref));
  await live.observe(lease(2));assert.notEqual(live.inputPurpose(live.inputs()[0].ref),purpose);
 }finally{assert.equal((await live.close()).confirmed,true);await site.close();}
 const other=await managedSite((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<label>Search<input name="q"></label><label>Search<input name="q"></label>');});
 const ambiguous=new LivePlaywright({sessionId:'session',threadId:'thread',network:other.gate,assertSession(){},perform:direct},{ignoreHTTPSErrors:true});
 try{const ctx=lease();ctx.resolveInput=()=>assert.fail('Ambiguous fields must not resolve owner input');const o=await ambiguous.open(ctx,'https://example.test/');assert.deepEqual(ambiguous.inputs(),[]);await assert.rejects(ambiguous.interact(ctx,{kind:'fill',observationId:o.id,ref:o.controls[0].ref,taskInputId:'old'}));}
 finally{assert.equal((await ambiguous.close()).confirmed,true);await other.close();}
});
test('forwarding preserves credentials omission and Chromium response cookie acceptance',{skip:!enabled,timeout:60000},async()=>{
 const requests=[];let done;const finished=new Promise(resolve=>done=resolve);
 const site=await managedSite((req,res)=>{requests.push({url:req.url,cookie:req.headers.cookie??''});res.setHeader('Content-Type','text/html');
  if(req.url==='/'){res.setHeader('Set-Cookie','private=synthetic;Secure;HttpOnly;SameSite=Strict');res.end(`<h1>Cookie policy</h1><script>(async()=>{await fetch('/omit',{credentials:'omit'});await fetch('/read');})()</script>`);}
  else{if(req.url==='/omit')res.setHeader('Set-Cookie','injected=synthetic;Secure;HttpOnly;SameSite=Strict');res.end('ok');if(req.url==='/read')done();}
 });
 const live=new LivePlaywright({sessionId:'session',threadId:'thread',network:site.gate,assertSession(){},perform:direct},{ignoreHTTPSErrors:true});
 try{await live.open(lease(),'https://example.test/');await Promise.race([finished,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Missing fixture requests')),5000).unref())]);
  assert.equal(requests.find(r=>r.url==='/omit').cookie,'');assert.equal(requests.find(r=>r.url==='/read').cookie,'private=synthetic');
 }finally{assert.equal((await live.close()).confirmed,true);await site.close();}
});

// The trusted fixture captures only its own synthetic page; no product CDP surface.
async function captureChromium(capture) {
 const {chromium}=await import('playwright');return {executablePath:()=>chromium.executablePath(),launchServer:o=>chromium.launchServer(o),connect:async(...args)=>{const browser=await chromium.connect(...args);browser.on('context',c=>c.on('page',capture));return browser;}};
}
test('covered controls cannot wait through a same-node destination change',{skip:!enabled,timeout:60000},async()=>{
 let page;const site=await managedSite((req,res)=>{res.setHeader('Content-Type','text/html');res.end(req.url==='/'?'<a id="target" href="/approved">Reviewed destination</a><div id="cover" style="position:fixed;inset:0;background:white;z-index:100">Overlay</div>':'<h1>Unapproved destination</h1>');});
 const live=new LivePlaywright({sessionId:'session',threadId:'thread',network:site.gate,assertSession(){},perform:async(ctx,command,detail,gesture)=>{
  await gesture.validate();if(command.operation==='interact')await page.evaluate(()=>setTimeout(()=>{document.querySelector('#target').href='/unapproved';document.querySelector('#cover').remove();},300));
  return {status:'accepted',actionId:'test',observation:await gesture.dispatch(()=>gesture.assertCurrent())};
 }},{ignoreHTTPSErrors:true,loadChromium:()=>captureChromium(p=>page=p)});
 try{const ctx=lease(),o=await live.open(ctx,'https://example.test/');await assert.rejects(live.interact(ctx,{kind:'navigate',observationId:o.id,ref:o.controls[0].ref}),error=>error.diagnostic?.code==='control_covered'&&error.diagnostic.phase==='validation');assert.ok(!site.requests.some(r=>r.url==='/unapproved'));assert.ok(!site.requests.some(r=>r.url==='/approved'));}
 finally{assert.equal((await live.close()).confirmed,true);await site.close();}
});
test('page prototype overrides cannot conceal same-node field or option changes',{skip:!enabled,timeout:60000},async()=>{
 let page,kind;const site=await managedSite((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<label>Query<input name="q"></label><select aria-label="City"><option>Alpha</option><option>Beta</option></select>');});
 const live=new LivePlaywright({sessionId:'session',threadId:'thread',network:site.gate,assertSession(){},perform:async(ctx,command,detail,gesture)=>{
  await gesture.validate();if(command.operation==='interact')await page.evaluate(kind=>{
   if(kind==='fill'){document.querySelector('input').name='changed';Object.defineProperty(HTMLInputElement.prototype,'name',{get(){return 'q'}});}
   else{document.querySelector('option').value='changed';Object.defineProperty(HTMLOptionElement.prototype,'value',{get(){return this.text}});}
  },kind);
  await gesture.validate();return {status:'accepted',actionId:'test',observation:await gesture.dispatch(()=>gesture.assertCurrent())};
 }},{ignoreHTTPSErrors:true,loadChromium:()=>captureChromium(p=>page=p)});
 try{const ctx=lease();let o=await live.open(ctx,'https://example.test/');kind='fill';await assert.rejects(live.interact(ctx,{kind:'fill',observationId:o.id,ref:o.controls[0].ref,taskInputId:'input'}));
  o=await live.observe(ctx);kind='select';const select=o.controls.find(c=>c.role==='combobox');await assert.rejects(live.interact(ctx,{kind:'select',observationId:o.id,ref:select.ref,optionRef:select.options[0].ref}));
 }finally{assert.equal((await live.close()).confirmed,true);await site.close();}
});
test('cross-site fetch preserves SameSite cookie exclusion and rejected response cookies',{skip:!enabled,timeout:60000},async()=>{
 const requests=[];let done;const finished=new Promise(resolve=>done=resolve);
 const site=await managedSite((req,res)=>{requests.push({url:req.url,cookie:req.headers.cookie??''});res.setHeader('Content-Type','text/html');
  if(req.url==='/seed'){res.setHeader('Set-Cookie','strict=synthetic;Secure;HttpOnly;SameSite=Strict');return res.end('<a href="https://example.test/">Main site</a>');}
  if(req.url==='/'){return res.end(`<h1>Main</h1><a href="https://other.test/read">Read cookies</a><script>fetch('https://other.test/cross',{credentials:'include'}).then(()=>fetch('/done'))</script>`);}
  if(req.url==='/cross'){res.setHeader('Access-Control-Allow-Origin','https://example.test');res.setHeader('Access-Control-Allow-Credentials','true');res.setHeader('Set-Cookie','rejected=synthetic;Secure;HttpOnly;SameSite=Strict');}
  res.end('<h1>Read</h1><a href="/final">Same-site read</a>');if(req.url==='/done')done();
 });
 const live=new LivePlaywright({sessionId:'session',threadId:'thread',network:site.gate,assertSession(){},perform:direct},{ignoreHTTPSErrors:true});
 try{const ctx=lease();let o=await live.open(ctx,'https://other.test/seed');o=await live.interact(ctx,{kind:'navigate',observationId:o.id,ref:o.controls[0].ref});
  await Promise.race([finished,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Missing cross-site request')),5000).unref())]);assert.equal(requests.find(r=>r.url==='/cross').cookie,'');
  o=await live.interact(ctx,{kind:'navigate',observationId:o.id,ref:o.controls[0].ref});
  // Strict cookies are excluded on the cross-site navigation, too. A same-site read
  // then proves that the response cookie was not secretly imported by the forwarder.
  await live.interact(ctx,{kind:'navigate',observationId:o.id,ref:o.controls[0].ref});
  assert.equal(requests.find(r=>r.url==='/final').cookie,'strict=synthetic');
  assert.ok(requests.every(r=>!r.cookie.includes('rejected=')));
 }finally{assert.equal((await live.close()).confirmed,true);await site.close();}
});
test('assets and allowed redirects work; approvals identify options and mutating GET destinations; files stay unavailable',{skip:!enabled,timeout:60000},async()=>{
 let effects=0;const reviews=[];const site=await managedSite((req,res)=>{
  if(req.url==='/style.css'){res.setHeader('Content-Type','text/css');return res.end('body{color:rgb(1,2,3)}');}
  if(req.url==='/image.svg'){res.setHeader('Content-Type','image/svg+xml');return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');}
  if(req.url==='/redirect'){res.writeHead(302,{location:'/changed'});return res.end();}
  if(req.url==='/attachment'){res.setHeader('Content-Disposition','attachment; filename=blocked.txt');return res.end('blocked');}
  if(req.url==='/changed'){effects++;res.setHeader('Content-Type','text/html');return res.end('<h1>Changed once</h1><a href="/attachment">Attachment</a>');}
  res.setHeader('Content-Type','text/html');res.end('<link rel="stylesheet" href="/style.css"><img src="/image.svg"><select aria-label="City"><option>Alpha</option><option>Beta</option></select><a href="/redirect">Apply change</a><a download href="/download">Download</a><input type="file" aria-label="Upload">');
 });
 const live=new LivePlaywright({sessionId:'session',threadId:'thread',network:site.gate,assertSession(){},perform:async(ctx,command,detail,gesture)=>{reviews.push(detail);if(detail.name!=='Attachment')assert.equal(effects,0);return direct(ctx,command,detail,gesture);}},{ignoreHTTPSErrors:true});
 try{const ctx=lease();let o=await live.open(ctx,'https://example.test/');assert.ok(!o.controls.some(c=>/Download|Upload/.test(c.name)));
  const select=o.controls.find(c=>c.role==='combobox');o=await live.interact(ctx,{kind:'select',observationId:o.id,ref:select.ref,optionRef:select.options[1].ref});assert.equal(reviews.at(-1).option,'Beta');
  o=await live.interact(ctx,{kind:'navigate',observationId:o.id,ref:o.controls.find(c=>c.name==='Apply change').ref});assert.equal(reviews.at(-1).destination,'https://example.test/redirect');assert.equal(effects,1);assert.match(o.text,/Changed once/);
  for(const path of ['/style.css','/image.svg','/redirect','/changed'])assert.ok(site.requests.some(r=>r.url===path),path);assert.ok(!site.requests.some(r=>/download|upload/.test(r.url)));
  await assert.rejects(live.interact(ctx,{kind:'navigate',observationId:o.id,ref:o.controls[0].ref}));
 }finally{assert.equal((await live.close()).confirmed,true);await site.close();}
});
test('two managed browser sessions have separate cookie jars and controls',{skip:!enabled,timeout:60000},async()=>{
 const handler=(req,res)=>{res.setHeader('Content-Type','text/html');if(req.url==='/seed')res.setHeader('Set-Cookie','account=synthetic;Secure;HttpOnly');res.end('<h1>'+(req.headers.cookie?'Authenticated':'Anonymous')+'</h1><a href="/read">Read</a>');};
 const one=await managedSite(handler),two=await managedSite(handler);
 const first=new LivePlaywright({sessionId:'session',threadId:'one',network:one.gate,assertSession(){},perform:direct},{ignoreHTTPSErrors:true});
 const second=new LivePlaywright({sessionId:'other',threadId:'two',network:two.gate,assertSession(){},perform:direct},{ignoreHTTPSErrors:true});
 try{const ctx=lease();let a=await first.open(ctx,'https://example.test/seed');a=await first.interact(ctx,{kind:'navigate',observationId:a.id,ref:a.controls[0].ref});assert.match(a.text,/Authenticated/);
  const other={...lease(),sessionId:'other',workId:'other-work'};const b=await second.open(other,'https://example.test/read');assert.match(b.text,/Anonymous/);
  await assert.rejects(second.interact(other,{kind:'navigate',observationId:a.id,ref:a.controls[0].ref}));
 }finally{assert.equal((await first.close()).confirmed,true);assert.equal((await second.close()).confirmed,true);await one.close();await two.close();}
});
test('atomic dispatch rechecks same-node link, field, form and option semantics after the journal mark',{skip:!enabled,timeout:60000},async()=>{
 const {chromium}=await import('playwright');let page,mutation;const reviews=[];
 const site=await managedSite((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<a id="link" href="/reviewed">Link</a><form action="/reviewed"><label>Query<input name="q"></label><button name="op" value="preview">Submit</button></form><label><input type="checkbox" name="flag" value="preview">Toggle</label><select aria-label="City"><option>Alpha</option><option>Beta</option></select>');});
 const live=new LivePlaywright({sessionId:'session',threadId:'thread',network:site.gate,assertSession(){},perform:async(...args)=>{reviews.push(args[2]);return direct(...args);}},{ignoreHTTPSErrors:true,loadChromium:async()=>({executablePath:()=>chromium.executablePath(),launchServer:o=>chromium.launchServer(o),connect:async(...args)=>{
  const browser=await chromium.connect(...args);browser.on('context',context=>{context.on('page',p=>page=p);const original=context.newCDPSession.bind(context);context.newCDPSession=async p=>{const cdp=await original(p),send=cdp.send.bind(cdp);cdp.send=async(method,params)=>{
   if(method==='Runtime.callFunctionOn'&&params.arguments?.[0]?.value==='dispatch'&&mutation){const change=mutation;mutation=undefined;await page.evaluate(change);}
   return send(method,params);
  };return cdp;};});return browser;
 }})});
 try{const ctx=lease();await live.open(ctx,'https://example.test/');
  const cases=[['navigate','Link',()=>document.querySelector('#link').href='/unreviewed'],['fill','Query',()=>document.querySelector('input').name='different'],['click','Submit',()=>document.querySelector('form').action='/unreviewed'],['select','City',()=>document.querySelector('option').value='different'],['click','Submit',()=>document.querySelector('button').value='delete'],['click','Toggle (unchecked)',()=>document.querySelector('[name=flag]').value='delete']];
  cases.push(['navigate','Link',()=>document.querySelector('#link').remove(),'control_missing'],['fill','Query',()=>document.querySelector('input').parentElement.after(document.querySelector('input').parentElement.cloneNode(true)),'field_ambiguous']);
  for(const [kind,name,change,code='control_changed'] of cases){const o=await live.observe(ctx),control=o.controls.find(c=>c.name===name);mutation=change;await assert.rejects(live.interact(ctx,{kind,observationId:o.id,ref:control.ref,...(kind==='fill'?{taskInputId:'input'}:{}),...(kind==='select'?{optionRef:control.options[0].ref}:{})}),error=>error.diagnostic?.code===code);}
  assert.ok(site.requests.every(r=>r.url==='/'));assert.equal(reviews.find(r=>r.operation==='click').form.action,'https://example.test/reviewed');
 }finally{assert.equal((await live.close()).confirmed,true);await site.close();}
});
test('duplicate visible option names do not expose ambiguous selection authority',{skip:!enabled,timeout:60000},async()=>{
 const site=await managedSite((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<select aria-label="City"><option value="a">Same city</option><option value="b">Same city</option></select>');});
 const live=new LivePlaywright({sessionId:'session',threadId:'thread',network:site.gate,assertSession(){},perform:direct},{ignoreHTTPSErrors:true});
 try{const o=await live.open(lease(),'https://example.test/');assert.ok(!o.controls.some(c=>c.role==='combobox'));}
 finally{assert.equal((await live.close()).confirmed,true);await site.close();}
});
