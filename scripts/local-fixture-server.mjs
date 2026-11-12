// Offline integration fixture: real Rust decisions + D1-compatible SQLite,
// captured public source text, mocked GitHub visibility, no generation service.
import {createServer} from 'node:http';
import {readFileSync,existsSync} from 'node:fs';
import {join,resolve,extname} from 'node:path';
import worker from '../dist-test/src/index.js';
import {fixture,mockFetch} from '../dist-test/test/helpers.js';
const {env,sqlite}=fixture();env.AI=undefined;env.PUBLIC_SEARCH_RATE_LIMIT={limit:async()=>({success:true})};
const passages=JSON.parse(readFileSync('test/fixtures/public-passages.json','utf8'));
for(const repo of new Set(passages.map(p=>p.repo)))sqlite.prepare("INSERT INTO repositories(repo,description,default_branch) VALUES(?,?,'main')").run(repo,'Public fixture');
// Preserve captured passage boundaries and IDs, rather than re-splitting excerpts.
for(const p of passages){
 sqlite.prepare('INSERT OR IGNORE INTO sources(id,repo,kind,title,url,body,metadata,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(p.source_id,p.repo,p.kind,p.title,p.url,p.text,JSON.stringify(p.metadata),p.updated_at);
 sqlite.prepare('INSERT INTO passages(id,source_id,ordinal,text) VALUES(?,?,?,?)').run(p.id,p.source_id,p.ordinal,p.text);
}
mockFetch(url=>{if(url.includes('api.github.com/orgs/TrainLCD/repos'))return Response.json([...new Set(passages.map(p=>p.repo))].map(full_name=>({full_name,private:false,visibility:'public'})));throw new Error('Unexpected network: '+url);});
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://127.0.0.1:8787');
  if(['/search','/answer','/health','/sync/status'].includes(url.pathname)){
   const chunks=[];for await(const c of req)chunks.push(c);
   const response=await worker.fetch(new Request(url,{method:req.method,headers:req.headers,...(req.method==='POST'?{body:Buffer.concat(chunks)}:{})}),env,{});
   res.writeHead(response.status,Object.fromEntries(response.headers));
   if(response.body)for await(const chunk of response.body)res.write(chunk);res.end();return;
  }
  const root=resolve('public');const file=resolve(join(root,url.pathname==='/'?'index.html':url.pathname.slice(1)));
  if(!file.startsWith(root+'/')||!existsSync(file)){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'content-type':types[extname(file)]||'application/octet-stream'});res.end(readFileSync(file));
 }catch(e){console.error(e);res.writeHead(500);res.end('fixture_error');}
}).listen(8787,'127.0.0.1',()=>console.log('Fixture ready on http://127.0.0.1:8787'));
