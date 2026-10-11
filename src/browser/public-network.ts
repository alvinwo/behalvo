import { lookup } from 'node:dns/promises';
import { createServer, type Server } from 'node:http';
import { BlockList, createConnection, isIP, type Socket } from 'node:net';
import { withinExecution } from '../operations/execution-context.js';

const denied4=new BlockList();
// Conservative special-purpose ranges, based on IANA's IPv4/IPv6 registries.
for(const [address,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],
    ['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],
    ['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const)
    denied4.addSubnet(address,prefix,'ipv4');
const global6=new BlockList();global6.addSubnet('2000::',3,'ipv6');
const denied6=new BlockList();
for(const [address,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]] as const)
    denied6.addSubnet(address,prefix,'ipv6');
export function isPublicAddress(address:string):boolean {
    return isIP(address)===4?!denied4.check(address,'ipv4'):
        isIP(address)===6&&global6.check(address,'ipv6')&&!denied6.check(address,'ipv6');
}
export function publicHttpsUrl(value:string):URL {
    if(typeof value!=='string'||Buffer.byteLength(value,'utf8')>4096||/[\\\s\u0000-\u001f]/.test(value))throw new Error('Invalid HTTPS URL');
    const url=new URL(value);const host=url.hostname.replace(/^\[|\]$/g,'');
    if(url.protocol!=='https:'||url.username||url.password||!host||host.endsWith('.')||
        (isIP(host)?!isPublicAddress(host):!host.includes('.')||/\.(?:localhost|local|internal|home|lan|arpa)$/i.test(host)))
        throw new Error('Public HTTPS destination required');
    return url;
}
export interface PublicNetworkDependencies {
    /** Trusted synthetic seams only. Address validation is always applied before dialing. */
    resolve?(hostname:string):Promise<string[]>;
    dial?(address:string,port:number):Socket;
}
/** TLS remains end-to-end; the gate sees no cookies, headers, bodies or page content. */
export class PublicNetworkGate {
    readonly #origins=new Set<string>();readonly #blocked=new Set<string>();readonly #sockets=new Set<Socket>();readonly #tunnels=new Set<Socket>();
    #server:Server|undefined;#listening:Promise<void>|undefined;#closing:Promise<{confirmed:boolean}>|undefined;#proxyUrl:string|undefined;#closed=false;#revision=1;#requests=0;#bytes=0;
    constructor(origins:readonly string[],private readonly assertActive:()=>void,private readonly dependencies:PublicNetworkDependencies={}) {
        if(!origins.length||origins.length>8)throw new Error('Invalid browser origin grant');
        for(const origin of origins){const url=publicHttpsUrl(origin);if(url.origin!==origin)throw new Error('Exact browser origin required');this.#origins.add(origin);}
    }
    get proxyUrl():string {if(!this.#proxyUrl||this.#closed)throw new Error('Browser network gate unavailable');return this.#proxyUrl;}
    get revision():number{return this.#revision;}
    get origins():string[]{return [...this.#origins];}
    get blockedOrigins():string[]{return [...this.#blocked];}
    #check():void {if(this.#closed)throw new Error('Browser network gate closed');this.assertActive();}
    allows(value:string):URL {
        this.#check();const url=publicHttpsUrl(value);
        if(!this.#origins.has(url.origin)){if(this.#blocked.size<16)this.#blocked.add(url.origin);throw new Error('Browser origin is not granted');}
        return url;
    }
    assertAllowed(value:string):void {
        this.allows(value);
        if(++this.#requests>2048)throw new Error('Browser request limit reached');
    }
    allow(value:string):void {
        this.#check();const url=publicHttpsUrl(value);
        if(url.origin!==value)throw new Error('Exact browser origin required');
        if(this.#origins.has(value))return;
        if(this.#origins.size>=8)throw new Error('Browser origin limit reached');
        this.#origins.add(value);this.#blocked.delete(value);this.#revision++;
    }
    revoke(value:string):void {
        this.#check();if(this.#origins.delete(value)){this.#revision++;for(const socket of this.#sockets)socket.destroy();}
    }
    async start():Promise<void> {
        this.#check();if(this.#server)throw new Error('Browser network gate already started');
        const server=createServer({maxHeaderSize:8192,headersTimeout:10000,requestTimeout:10000},(_req,res)=>{res.writeHead(403);res.end();});this.#server=server;
        server.on('connection',socket=>{
            if(this.#closed||this.#sockets.size>=64){socket.destroy();return;}
            this.#sockets.add(socket);socket.setTimeout(60000,()=>socket.destroy());
            socket.on('error',()=>socket.destroy());socket.on('close',()=>this.#sockets.delete(socket));
        });
        server.on('clientError',(_error,socket)=>socket.destroy());
        server.on('connect',(request,client,head)=>{void this.#connect(request.url??'',client as Socket,head);});
        this.#listening=new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
        await this.#listening;
        server.on('error',()=>{void this.close();});
        this.#check();const address=server.address();if(!address||typeof address==='string')throw new Error('Browser network gate unavailable');
        this.#proxyUrl=`http://127.0.0.1:${address.port}`;
    }
    async #connect(authority:string,client:Socket,head:Buffer):Promise<void> {
        let upstream:Socket|undefined;
        const destroy=()=>{client.destroy();upstream?.destroy();};
        try {
            this.#check();
            if(!/^(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+):[0-9]{1,5}$/.test(authority)||this.#tunnels.size>=32)throw new Error('Invalid CONNECT request');
            this.#tunnels.add(client);client.on('close',()=>this.#tunnels.delete(client));
            const url=this.allows(`https://${authority}`);const host=url.hostname.replace(/^\[|\]$/g,'');const port=Number(url.port||443);
            const addresses=isIP(host)?[host]:await withinExecution(()=>(this.dependencies.resolve??(async name=>(await lookup(name,{all:true,verbatim:true})).map(a=>a.address)))(host),{deadline:Date.now()+10000});
            this.allows(url.href);
            if(!addresses.length||addresses.length>32||addresses.some(a=>!isPublicAddress(a)))throw new Error('Non-public browser destination');
            this.#check();if(client.destroyed)throw new Error('Browser tunnel retired');
            // Pass the validated address, never a hostname that could be resolved again.
            upstream=(this.dependencies.dial??((address,port)=>createConnection({host:address,port})))(addresses[0]!,port);
            this.#sockets.add(upstream);const remote=upstream;
            remote.on('error',destroy);remote.on('close',()=>{this.#sockets.delete(remote);client.destroy();});
            client.on('close',()=>remote.destroy());remote.setTimeout(60000,destroy);
            await withinExecution(()=>new Promise<void>((resolve,reject)=>{remote.once('connect',resolve);remote.once('error',reject);}),{deadline:Date.now()+10000});
            this.allows(url.href);if(client.destroyed||remote.destroyed)throw new Error('Browser tunnel retired');
            const account=(chunk:Buffer)=>{this.#bytes+=chunk.length;if(this.#bytes>128*1024*1024){void this.close();throw new Error('Browser traffic limit reached');}};
            const count=(chunk:Buffer)=>{try{this.#check();account(chunk);}catch{destroy();}};
            client.on('data',count);remote.on('data',count);
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if(head.length){account(head);remote.write(head);}
            client.pipe(remote);remote.pipe(client);
        } catch {
            if(!client.destroyed)client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            upstream?.destroy();
        }
    }
    close():Promise<{confirmed:boolean}> {return this.#closing??=(async()=>{
        this.#closed=true;for(const socket of this.#sockets)socket.destroy();
        // listen() can finish after close is requested. Await that owned attempt
        // before claiming absence; otherwise a late listener survives confirmed cleanup.
        try{await this.#listening;}catch{/* A failed bind owns no listening socket. */}
        const server=this.#server;if(!server?.listening)return {confirmed:true};
        await new Promise<void>(resolve=>server.close(()=>resolve()));
        return {confirmed:!server.listening&&[...this.#sockets].every(s=>s.destroyed)};
    })();}
}
