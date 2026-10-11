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

test('route guard denies ungranted redirects, popup, WebSocket and service worker traffic', { skip: !enabled, timeout: 60000 }, async () => {
  const site = await managedSite((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: 'https://other.test/forbidden' }); return res.end(); }
    res.setHeader('Content-Type', 'text/html');res.end(`<h1>Boundary</h1><script>new WebSocket('wss://example.test/ws');navigator.serviceWorker.register('/sw.js').catch(()=>{});window.open('/popup');fetch('https://other.test/foreign').catch(()=>{});</script><a href="/redirect">Redirect</a>`);
  });
  const live = new LivePlaywright({ sessionId: 'session', threadId: 'thread', network: site.gate, assertSession() {}, perform: direct }, { ignoreHTTPSErrors: true });
  try {
    const ctx = lease();const o = await live.open(ctx, 'https://example.test/');
    await assert.rejects(live.interact(ctx, { kind: 'navigate', observationId: o.id, ref: o.controls[0].ref }));
    assert.ok(!site.requests.some(r => /forbidden|foreign|sw.js|ws|popup/.test(r.url)));
    assert.ok(site.gate.blockedOrigins.includes('https://other.test'));
  } finally { assert.equal((await live.close()).confirmed, true); await site.close(); }
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
