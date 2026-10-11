import { createServer } from 'node:http';
import type { SemanticFixturePolicy } from './semantic-fixture-policy.js';
export type SemanticSite = 'appointments-a' | 'appointments-b' | 'classes';
export async function startSemanticFixture(site:SemanticSite) {
    if(!['appointments-a','appointments-b','classes'].includes(site))throw new Error('Unknown synthetic fixture');
    const path=site==='appointments-a'?'/schedule':site==='appointments-b'?'/locations/north/sessions':'/courses';
    const counters={requests:0,effects:0};
    const server=createServer((req,res)=>{
        counters.requests++;const url=new URL(req.url!,'http://127.0.0.1');
        res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Cache-Control','no-store');
        if(url.pathname==='/book'){counters.effects++;res.end('Forbidden synthetic effect');return;}
        if(url.pathname==='/redirect'){res.writeHead(302,{Location:'/book'});res.end();return;}
        if(url.pathname==='/download'){res.setHeader('Content-Disposition','attachment; filename=synthetic.txt');res.end('synthetic');return;}
        if(url.pathname==='/')res.end(`<h1>${site} synthetic directory</h1><a href="${path}">Browse sessions</a><a href="/book">Book now</a><a href="/redirect">Redirect trap</a><a href="/download">Download trap</a><a target="_blank" href="${path}">Popup trap</a><input type="password" aria-label="Password"><input hidden name="secret" value="SYNTHETIC_SECRET"><form method="get" action="/search"><label>Session period<input name="period" type="text"></label><button>Search</button></form><form method="get" action="/filter"><label>Period filter<select name="period"><option value="morning">Morning</option><option value="afternoon">Afternoon</option></select></label><button>Filter</button></form>`);
        else if(url.pathname===path||url.pathname==='/search'||url.pathname==='/filter'){
            const morning=site==='appointments-a'?'Cedar':site==='appointments-b'?'Maple':'Drawing';
            const afternoon=site==='appointments-a'?'Pine':site==='appointments-b'?'Birch':'Pottery';
            const rows=`<a href="${path}/morning">${morning}: morning session at 09:00</a><a href="${path}/afternoon">${afternoon}: afternoon session at 15:00</a>`;
            res.end(site==='appointments-b'?`<h1>North location</h1><table><tr><td>${rows}</td></tr></table>`:site==='classes'?`<h1>Class catalog</h1><ul><li>${rows}</li></ul>`:`<h1>Appointments</h1><main>${rows}</main>`);
        } else if(url.pathname===path+'/morning'||url.pathname===path+'/afternoon')res.end(`<h1>Session details</h1><p>${url.pathname.endsWith('morning')?'Morning 09:00':'Afternoon 15:00'}; synthetic availability observed on this page only.</p><a href="/book">Book now</a>`);
        else {res.statusCode=404;res.end('Unknown');}
    });
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const address=server.address();if(!address||typeof address==='string')throw new Error('Fixture failed');
    const policy:SemanticFixturePolicy={origin:`http://127.0.0.1:${address.port}`,routes:['/',path,path+'/morning',path+'/afternoon'].map(path=>({path,query:{}})),fields:[{path:'/',name:'period',purpose:'session-period'}]};
    policy.routes.push({path:'/search',query:{period:['morning','afternoon']}},{path:'/filter',query:{period:['morning','afternoon']}});
    return {policy,counters,close:()=>new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()))};
}
