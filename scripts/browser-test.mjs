import {chromium} from 'playwright';
import {spawn,execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const server=spawn(process.execPath,['--loader','./scripts/wasm-test-loader.mjs','scripts/local-fixture-server.mjs'],{stdio:['ignore','pipe','inherit']});

let browser,page;
try{
 await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Fixture startup timeout')),15000);server.stdout.on('data',data=>{if(String(data).includes('Fixture ready')){clearTimeout(timeout);resolve();}});server.on('error',error=>{clearTimeout(timeout);reject(error);});server.on('exit',code=>{clearTimeout(timeout);reject(Error('Fixture exited '+code));});});
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
 page=await browser.newPage({viewport:{width:1280,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));let searches=0;
 page.on('request',r=>{if(/\/(search|answer)$/.test(r.url()))searches++;});
 await page.addInitScript(()=>{const original=window.fetch;window.fetch=async(...args)=>{const response=await original(...args);if(response.headers.get('content-type')?.includes('text/event-stream')){window.__answerWire=null;void response.clone().text().then(text=>{window.__answerWire=text;});}return response;};});
 await page.goto('http://127.0.0.1:8787');await page.locator('#query').fill('地下鉄で位置更新が止まる問題');
 const responsePromise=page.waitForResponse(r=>r.url().endsWith('/answer'));
 await page.locator('#search-button').click();const response=await responsePromise;assert.equal(response.status(),200);
 await page.waitForFunction(()=>typeof window.__answerWire==='string');const wire=await page.evaluate(()=>window.__answerWire);assert.ok(wire.includes('event: sources'));assert.ok(wire.includes('event: result'));
 const result=JSON.parse(wire.split('event: result\ndata: ')[1].trim());assert.ok(result.hit_count>20);
 await page.waitForFunction(()=>document.querySelector('#results').getAttribute('aria-busy')==='false');
 assert.ok(await page.locator('.evidence-excerpt mark.search-match').count()>0,'Real Rust matches must be highlighted');
 const marks=await page.locator('.evidence-excerpt mark.search-match').allTextContents();
 assert.equal(await page.locator('mark.search-match').first().evaluate(n=>getComputedStyle(n).backgroundColor),'rgb(255, 235, 112)');
 assert.equal(await page.locator('.evidence-card').count(),10);const first=await page.locator('.evidence-card').first().textContent();
 const next=page.locator('#pagination-top [data-page-step="1"]');await next.click();assert.equal(await page.locator('.evidence-card').count(),10);assert.notEqual(await page.locator('.evidence-card').first().textContent(),first);
 assert.match(await page.locator('#pagination-top [data-page-label]').textContent(),new RegExp('2 / '+Math.ceil(result.hit_count/10)));
 await page.locator('#pagination-top [data-page-step="-1"]').click();assert.equal(await page.locator('.evidence-card').first().textContent(),first);assert.equal(searches,1,'Page navigation must never search or regenerate');
 assert.deepEqual(await page.locator('.evidence-excerpt mark.search-match').allTextContents(),marks);
 await mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/rust-browser.png',fullPage:true});
 await page.locator('#query').fill('zzqnonexistentzzq');await page.locator('#search-button').click();await page.waitForFunction(()=>document.querySelector('#results').getAttribute('aria-busy')==='false');assert.equal(await page.locator('.evidence-card').count(),0);
 // Replay the actual Rust response produced by the GTFS integration regression.
 execFileSync(process.execPath,['--loader','./scripts/wasm-test-loader.mjs','--test','dist-test/test/gtfs-answer-regression.test.js'],{stdio:'inherit'});
 await page.route('**/answer',route=>route.fulfill({status:200,contentType:'text/event-stream',body:readFileSync('test-results/gtfs-answer-stream.sse','utf8')}));
 await page.locator('#query').fill('gtfs導入の際の課題と議論');await page.locator('#search-button').click();
 await page.waitForFunction(()=>document.querySelector('#results').getAttribute('aria-busy')==='false');
 const answerPanel=page.locator('#answer-panel');
 assert.match(await answerPanel.textContent(),/バスデータの特性/);
 assert.doesNotMatch(await answerPanel.textContent(),/回答を確認できませんでした|資料の記載：|FNC-1a|生成中/);
 assert.ok(await answerPanel.locator('code').count()>0,'Final Markdown code must be rendered');
 assert.ok(await answerPanel.locator('a[href^="#evidence-"]').count()>0,'Citations must remain links');
 await page.screenshot({path:'test-results/gtfs-summary-markdown.png',fullPage:true});
 // Draft summaries use source IDs, not result order, and work before completion.
 await page.evaluate(result => {
   renderAnswerProgress('sources', result, 'draft links');
   const source = result.evidence[10];
   renderAnswerProgress('draft', {
     summaries: ['**生成途中**', 'unknown'],
     summaries_html: ['<p><strong>生成途中</strong></p>', '<p>unknown</p>'],
     summary_source_ids: [source.source_id, 'missing-source'],
   }, 'draft links');
 }, result);
 const draftSource=result.evidence.find(entry=>entry.source_id===result.evidence[10].source_id);
 assert.equal(await answerPanel.locator('h4 a').count(),1);
 assert.equal(await answerPanel.locator('h4 a').textContent(),draftSource.title);
 assert.equal(await answerPanel.locator('h4 a').getAttribute('href'),'#evidence-'+draftSource.citation);
 assert.equal(await answerPanel.locator('strong').textContent(),'生成途中');
 await answerPanel.locator('h4 a').click();
 assert.ok(await page.locator('[id="evidence-'+draftSource.citation+'"]').count()>0);
 assert.equal(searches,3,'Draft links must not search or regenerate');
 await page.evaluate(result=>renderResult(result,'answer','draft links'),result);
 assert.deepEqual(errors,[]);await writeFile('test-results/browser.json',JSON.stringify({backend:'Rust/WASM',hits:result.hit_count,per_page:10,pagination_requests:0,errors},null,2));console.log('Browser passed: real Rust/WASM, SSE, totals, 10 per page, no regeneration, empty result.');
}catch(error){await mkdir('test-results',{recursive:true});await page?.screenshot({path:'test-results/failure.png',fullPage:true}).catch(()=>{});throw error;}finally{await browser?.close();server.kill();}
