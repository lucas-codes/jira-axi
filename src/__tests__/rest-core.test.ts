import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../index.ts';
import { read, validateUrl } from '../api.ts';
const ORIGIN='https://example.atlassian.net';
import { env, run } from './rest-harness.ts';
test('REST me and status use authenticated GETs in order', async () => {
  for (const command of ['me','status']) { const r=await run([command,'--json']); assert.equal(r.exit,0,r.output); assert.equal(r.writes,1); assert.deepEqual(r.calls.map(c=>new URL(c.url).pathname),['/rest/api/3/myself','/rest/agile/1.0/board/42']); for(const c of r.calls){ assert.equal(c.init?.method,'GET');assert.equal(c.init?.redirect,'manual');assert.equal((c.init?.headers as Record<string,string>).Authorization,'Basic '+Buffer.from('reader@example.com:DUMMY_SECRET').toString('base64')); } }
});
test('status JSON login is the email, not the display-name fallback', async () => {
  const r=await run(['status','--json'],[{accountId:'a',displayName:'Reader'},{id:42,name:'DEMO'}]);assert.equal(r.exit,0);assert.equal(r.value.account,'Reader');assert.ok(!('login' in r.value));
});
test('HTTP failures, redirects and rate metadata are bounded', async () => {
  for(const [status,code] of [[301,'security'],[302,'security'],[303,'security'],[307,'security'],[308,'security'],[401,'unauthorized'],[403,'forbidden'],[404,'not_found'],[429,'rate_limited'],[500,'http_error']] as const){ const r=await run(['me','--json'],[{error:'DUMMY_SECRET'}],status,{'Retry-After':'12','RateLimit-Reason':'A\x1b[31mB'});assert.equal(r.exit,1);assert.equal(r.value.code,code);assert.equal(r.calls.length,1);assert.ok(!r.output.includes('DUMMY_SECRET'));if(status===429){assert.equal(r.value.retryAfter,12);assert.equal(r.value.limitReason,'AB');} }
});
test('credentials and schemas fail before unsafe use; status stays exit zero', async () => {
  for(const e of [{}, {...env,ATLASSIAN_EMAIL:'bad:email'}, {...env,ATLASSIAN_API_TOKEN:'bad\n'}]) {let calls=0,out='';const exit=await main(['me','--json'],{env:e,fetch:async()=>{calls++;throw Error();},write:s=>out+=s,stdin:{isTTY:true,read:()=>''}}); assert.equal(exit,1);assert.equal(calls,0);assert.match(out,/token_missing|security/);}
  for(const data of [null,[],{}, {accountId:''},{accountId:3}]) assert.equal((await run(['me','--json'],[data])).value.code,'bad_response');
  const r=await run(['status','--json'],[{}]);assert.equal(r.exit,0);assert.equal(r.value.reachable,false);assert.equal(r.calls.length,1);
  const board=await run(['me','--json'],[{accountId:'a'},{id:'42'}]);assert.equal(board.exit,0);assert.ok(!('board' in board.value));
});
test('URL allowlist rejects unsafe inputs and query keys', async () => {
  for(const input of ['https://[invalid','https://evil.test/rest/api/3/myself','http://example.atlassian.net/rest/api/3/myself',ORIGIN+':444/rest/api/3/myself','https://@example.atlassian.net/rest/api/3/myself',ORIGIN+'/rest/api/3/myself#',ORIGIN+'/rest/api/3/my\nself',ORIGIN+'/rest/api/3/myself?token=x',ORIGIN+'/rest/api/3/issue/DEMO-0']) assert.throws(()=>validateUrl('GET',input,ORIGIN),{code:'security'});
  assert.throws(()=>validateUrl('POST',ORIGIN+'/rest/api/3/search/jql',ORIGIN),{code:'security'});
});
test('transport, malformed JSON, content type and response cap', async () => {
  for(const [fetcher,code] of [[async()=>{throw Error('DUMMY_SECRET');},'transport_error'],[async()=>new Response('bad',{headers:{'content-type':'application/json'}}),'bad_json'],[async()=>new Response('{}'),'bad_json'],[async()=>Response.json('x'.repeat(5*1024*1024)),'response_too_large']] as [typeof fetch,string][]) await assert.rejects(read('/rest/api/3/myself',new URLSearchParams(),{env,fetch:fetcher}),{code});
});
test('REST sanitizes and double redacts strings in both formats', async () => {
  for(const json of [false,true]) {const r=await run(['me',...(json?['--json']:[])],[{accountId:'a',displayName:'DUMMY_\x1b[31mSECRET\0\u009b31m',emailAddress:null},{id:42,name:'A\x1b]0;evil\x07B'}]);assert.equal(r.exit,0);for(const s of ['DUMMY_SECRET','evil','31m'])assert.ok(!r.output.includes(s),r.output);}
});
test('JIRA_AXI_BACKEND is ignored: every value uses REST',async()=>{
 for(const backend of ['cli','rest','no','']) {
  let calls=0,out='';
  const exit=await main(['me','--json'],{env:{...env,JIRA_AXI_BACKEND:backend},fetch:async()=>{calls++;return Response.json(calls===1?{accountId:'a',displayName:'Reader'}:{id:42,name:'DEMO'});},write:s=>out+=s,stdin:{isTTY:true,read:()=>''}});
  assert.equal(exit,0,out);assert.equal(JSON.parse(out).account,'Reader');assert.equal(calls,2);
 }
});
