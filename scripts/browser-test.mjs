import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const server=spawn(process.execPath,['--loader','./scripts/wasm-test-loader.mjs','scripts/local-fixture-server.mjs'],{stdio:['ignore','pipe','inherit']});
await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Fixture startup timeout')),15000);server.stdout.on('data',data=>{if(String(data).includes('Fixture ready')){clearTimeout(timeout);resolve();}});server.on('exit',code=>reject(Error('Fixture exited '+code)));});
let browser;
try{
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
 const page=await browser.newPage({viewport:{width:1280,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));let searches=0;
 page.on('request',r=>{if(/\/(search|answer)$/.test(r.url()))searches++;});
 await page.goto('http://127.0.0.1:8787');await page.locator('#query').fill('地下鉄で位置更新が止まる問題');
 const responsePromise=page.waitForResponse(r=>r.url().endsWith('/answer'));
 await page.locator('#search-button').click();const response=await responsePromise;assert.equal(response.status(),200);
 const wire=await response.text();assert.ok(wire.includes('event: sources'));assert.ok(wire.includes('event: result'));
 const result=JSON.parse(wire.split('event: result\ndata: ')[1].trim());assert.ok(result.hit_count>20);
 await page.waitForFunction(()=>document.querySelector('#results').getAttribute('aria-busy')==='false');
 assert.equal(await page.locator('.evidence-card').count(),10);const first=await page.locator('.evidence-card').first().textContent();
 const next=page.locator('#pagination-top [data-page-step="1"]');await next.click();assert.equal(await page.locator('.evidence-card').count(),10);assert.notEqual(await page.locator('.evidence-card').first().textContent(),first);
 assert.match(await page.locator('#pagination-top [data-page-label]').textContent(),new RegExp('2 / '+Math.ceil(result.hit_count/10)));
 await page.locator('#pagination-top [data-page-step="-1"]').click();assert.equal(await page.locator('.evidence-card').first().textContent(),first);assert.equal(searches,1,'Page navigation must never search or regenerate');
 await mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/rust-browser.png',fullPage:true});
 await page.locator('#query').fill('zzqnonexistentzzq');await page.locator('#search-button').click();await page.waitForFunction(()=>document.querySelector('#results').getAttribute('aria-busy')==='false');assert.equal(await page.locator('.evidence-card').count(),0);
 assert.deepEqual(errors,[]);await writeFile('test-results/browser.json',JSON.stringify({backend:'Rust/WASM',hits:result.hit_count,per_page:10,pagination_requests:0,errors},null,2));console.log('Browser passed: real Rust/WASM, SSE, totals, 10 per page, no regeneration, empty result.');
}finally{await browser?.close();server.kill();}
