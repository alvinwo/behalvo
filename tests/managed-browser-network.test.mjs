import test from 'node:test';import assert from 'node:assert/strict';import net from 'node:net';
const api=()=>import('../dist/browser/public-network.js');
test('public address and URL policy reject private, mapped, reserved and non-HTTPS destinations',async()=>{
 const {isPublicAddress,publicHttpsUrl}=await api();
 for(const ip of ['127.0.0.1','0.0.0.0','10.2.3.4','100.64.0.1','169.254.169.254','172.31.0.1','192.168.0.1','192.0.2.1','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255','::','::1','::ffff:127.0.0.1','::ffff:8.8.8.8','fc00::1','fe80::1','ff02::1','2001:db8::1','2002:7f00:1::1','3fff::1'])assert.equal(isPublicAddress(ip),false,ip);
 for(const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111','2001:4860:4860::8888'])assert.equal(isPublicAddress(ip),true,ip);
 for(const url of ['http://example.com','https://user:pass@example.com','file:///tmp/test','https://localhost','https://host.local','https://127.1','https://0x7f000001','https://[::1]','https://example.com\\@127.0.0.1'])assert.throws(()=>publicHttpsUrl(url),url);
 assert.equal(publicHttpsUrl('https://EXAMPLE.com:443/path').origin,'https://example.com');
});
async function connect(proxy,authority){const address=new URL(proxy);const socket=net.connect(Number(address.port),address.hostname);socket.on('error',()=>{});await new Promise((res,rej)=>{socket.once('connect',res);socket.once('error',rej);});socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);const response=await new Promise((res,rej)=>{socket.once('data',b=>res(b.toString()));socket.once('end',()=>res(''));socket.once('error',rej);});return {socket,response};}
test('CONNECT resolves once and dials the exact checked address, then destroys tunnels on close',async t=>{
 const {PublicNetworkGate}=await api();let looked=0;const dials=[];
 const server=net.createServer(s=>s.on('data',b=>s.write(b)));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const gate=new PublicNetworkGate(['https://example.test'],()=>{}, {resolve:async host=>{assert.equal(host,'example.test');looked++;return ['8.8.8.8'];},dial:(ip,port)=>{dials.push([ip,port]);return net.connect(server.address().port,'127.0.0.1');}});
 t.after(async()=>{await gate.close();await new Promise(r=>server.close(r));});await gate.start();
 const {socket,response}=await connect(gate.proxyUrl,'example.test:443');assert.match(response,/200/);assert.deepEqual(dials,[['8.8.8.8',443]]);assert.equal(looked,1);
 const gone=new Promise(r=>socket.once('close',r));await gate.close();await gone;assert.throws(()=>gate.assertAllowed('https://example.test/path'));
});
test('mixed DNS answers and ungranted origins deny before dialing; route limits are bounded',async t=>{
 const {PublicNetworkGate}=await api();let dials=0;
 const gate=new PublicNetworkGate(['https://example.test'],()=>{}, {resolve:async()=>['8.8.8.8','127.0.0.1'],dial:()=>{dials++;throw new Error('must not dial');}});await gate.start();t.after(()=>gate.close());
 for(const host of ['example.test:443','ungranted.test:443','127.0.0.1:443']){const {socket,response}=await connect(gate.proxyUrl,host);assert.doesNotMatch(response,/200/);socket.destroy();}
 assert.equal(dials,0);assert.throws(()=>gate.assertAllowed('https://ungranted.test/path'));
 gate.allow('https://cdn.example.test');gate.assertAllowed('https://cdn.example.test/resource');
 for(let i=1;i<2048;i++)gate.assertAllowed('https://example.test/resource');assert.throws(()=>gate.assertAllowed('https://example.test/overflow'),/limit/i);
});
test('revocation drops active tunnels and expired authority cannot admit new requests',async t=>{
 const {PublicNetworkGate}=await api();let active=true;
 const gate=new PublicNetworkGate(['https://example.com'],()=>{if(!active)throw new Error('expired');});await gate.start();t.after(()=>gate.close());
 active=false;assert.throws(()=>gate.assertAllowed('https://example.com'));assert.throws(()=>gate.allow('https://cdn.example.com'));
});
test('owned Chromium receives only a loopback proxy and fixed anti-bypass settings',async t=>{
 const {browserFixture}=await import('./helpers/playwright-fixture.mjs');const {PlaywrightProcessOwner}=await import('../dist/browser/playwright-process-owner.js');
 const f=browserFixture();t.after(f.dispose);
 const owner=new PlaywrightProcessOwner({signal:new AbortController().signal},{environment:{},networkProxy:'http://127.0.0.1:12345',loadChromium:async()=>f.chromium});
 await owner.start(async()=>null);assert.deepEqual(f.options.proxy,{server:'http://127.0.0.1:12345'});assert.ok(f.options.args.includes('--proxy-bypass-list=<-loopback>'));assert.ok(f.options.args.includes('--disable-quic'));assert.ok(f.options.args.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'));
 assert.equal((await owner.close()).confirmed,true);owner.finishReceipt(true,null,true);
});
test('invalid proxy configuration fails before launch and does not invent an unknown owned process',async t=>{
 const {browserFixture}=await import('./helpers/playwright-fixture.mjs');const {PlaywrightProcessOwner}=await import('../dist/browser/playwright-process-owner.js');
 const f=browserFixture();t.after(f.dispose);
 const owner=new PlaywrightProcessOwner({signal:new AbortController().signal},{environment:{},networkProxy:'http://external.example:8080',loadChromium:async()=>f.chromium});
 await assert.rejects(()=>owner.start(async()=>null));assert.equal(f.counts().launches,0);assert.equal((await owner.close()).confirmed,true);owner.finishReceipt(true,null,true);
});
