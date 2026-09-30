import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { main } from '../index.ts';
import { read, write, validateUrl } from '../api.ts';
import { confirmWrite, type PlannedWrite } from '../write-plan.ts';
import { parseArgs } from '../args.ts';
import { env, run } from './rest-harness.ts';
const plan:PlannedWrite={method:'POST',path:'/rest/api/3/issue',query:{},body:{fields:{summary:'New'}}};
test('deadline spans headers and body for GET and POST without retries',async(t)=>{
 t.mock.timers.enable({apis:['setTimeout']});
 for(const mutation of [false,true])for(const bodyHangs of [false,true]){
  let calls=0;const runtime={env,fetch:async()=>{calls++;if(!bodyHangs)return await new Promise<Response>(()=>{});return new Response(new ReadableStream({start(){}}),{status:mutation?201:200,headers:{'content-type':'application/json'}});}};
  const pending=mutation?write(plan,confirmWrite(parseArgs(['create','--yes']),plan)!,runtime):read('/rest/api/3/myself',new URLSearchParams(),runtime);
  const caught=assert.rejects(pending,mutation?{code:'write_outcome_unknown',details:{applied:'unknown'}}:{code:'transport_error'});
  for(let i=0;i<5;i++)await Promise.resolve();t.mock.timers.tick(30000);await caught;assert.equal(calls,1);
 }
});
test('write redirects every status never follow; method/path/query and grant mismatches refuse',async()=>{
 for(const status of [301,302,303,307,308]){let calls=0;const p={...plan};await assert.rejects(write(p,confirmWrite(parseArgs(['create','--yes']),p)!,{env,fetch:async()=>{calls++;return new Response(null,{status,headers:{location:'https://evil.test'}});}}),{code:'security',details:{applied:'unknown'}});assert.equal(calls,1);}
 for(const [method,url]of [['PUT','/rest/api/3/issue/DEMO-1/comment'],['POST','/rest/api/3/search/jql'],['DELETE','/rest/api/3/issue/DEMO-1'],['PUT','/rest/api/3/issue/DEMO-1?notifyUsers=true']])assert.throws(()=>validateUrl(method!,url!,'https://example.atlassian.net'),{code:'security'});
 await assert.rejects(write({...plan},confirmWrite(parseArgs(['create','--yes']),plan)!,{env,fetch:async()=>{throw Error('must not fetch');}}),{code:'security',details:{applied:false}});
});
test('400 details are bounded, invalid JSON is rejected, cap and content type are unknown after send',async()=>{
 for(const [body,headers,code]of [['not json',{'content-type':'application/json'},'rejected'],['{}',{},'rejected'],['x'.repeat(5*1024*1024+1),{'content-type':'application/json'},'write_outcome_unknown']] as [string,Record<string,string>,string][]){await assert.rejects(write(plan,confirmWrite(parseArgs(['create','--yes']),plan)!,{env,fetch:async()=>new Response(body,{status:400,headers})}),{code});}
 const r=await run(['list','--json'],[{errors:Object.fromEntries(Array.from({length:12},(_,i)=>['f'+i,'x'.repeat(300)])),errorMessages:Array(12).fill('z'.repeat(300))}],400);assert.equal(r.value.fields.length,10);assert.equal(r.value.fields[0].message.length,200);assert.equal(r.value.errorMessages.length,10);
 for(const status of [200,202,204]){await assert.rejects(write(plan,confirmWrite(parseArgs(['create','--yes']),plan)!,{env,fetch:async()=>status===204?new Response(null,{status}):Response.json({id:'a',key:'DEMO-1'},{status})}),{code:'write_outcome_unknown'});}
});
test('output caps, final serialized key leak check, missing token, status missing and bare keys',async()=>{
 const r=await run(['list','--full','--json'],[{issues:Array.from({length:100},()=>({key:'DEMO-1',fields:{summary:'x'.repeat(6000)}})),isLast:true}]);assert.equal(r.value.code,'output_too_large');assert.equal(r.writes,1);
 for(const json of [false,true]){let output='',calls=0;const exit=await main(['status',...(json?['--json']:[])],{env:{},stdin:{isTTY:true,read:()=>''},fetch:async()=>{calls++;throw Error();},write:s=>output+=s});assert.equal(exit,0);assert.equal(calls,0);assert.match(output,/unavailable|"reachable": false/);}
 let out='';const exit=await main(['unknown','--json'],{env:{...env,ATLASSIAN_API_TOKEN:'error'},stdin:{isTTY:true,read:()=>''},fetch:async()=>{throw Error();},write:s=>out+=s});assert.equal(exit,2);assert.equal(out,'\n');
 for(const token of ['',undefined]){let calls=0;out='';const exit=await main(['me','--json'],{env:{...env,ATLASSIAN_API_TOKEN:token},stdin:{isTTY:true,read:()=>''},fetch:async()=>{calls++;return Response.json({accountId:'a'});},write:s=>out+=s});assert.equal(exit,1);assert.equal(calls,0);assert.equal(JSON.parse(out).code,'token_missing');}
 const bare=await run(['DEMO-1','--json'],[{key:'DEMO-1',fields:{}},{comments:[],total:0}]);assert.equal(bare.exit,0);assert.equal(bare.value.key,'DEMO-1');
 for(const argv of [['--help'],['--version']])assert.equal((await run(argv)).exit,0);
});
test('REST TOON previews, applied summaries and structured error details',async()=>{
 for(const command of ['comment','create','edit']){
  const args=command==='comment'?['comment','DEMO-1']:command==='create'?['create','--summary','New','--type','Task']:['edit','DEMO-1','--priority','High'];
  for(const yes of [false,true]){let output='';const exit=await main([...args,...(command==='edit'?[]:['--file=-']),...(yes?['--yes']:[])],{env,stdin:{isTTY:true,read:()=>'<b>html'},fetch:async(_url,init)=>init?.method==='GET'?Response.json({key:'DEMO-1',fields:{summary:'Old'}}):init?.method==='PUT'?new Response(null,{status:204}):Response.json({id:'a',key:'DEMO-2'},{status:201}),write:s=>output+=s});assert.equal(exit,0,output);assert.match(output,new RegExp('applied: '+yes));}
 }
 const rejection=await run(['comment','DEMO-1','--file=missing','--yes']);assert.equal(rejection.exit,1);assert.match(rejection.output,/applied: false/);
 const rate=await run(['me'],[{}],429,{'Retry-After':'1','RateLimit-Reason':'reason'});assert.match(rate.output,/retryAfter: 1/);assert.match(rate.output,/limitReason: reason/);
 const field=await run(['list'],[{errors:{f:'Bad'},errorMessages:['Bad']}],400);assert.match(field.output,/fields\[1\]/);assert.match(field.output,/errorMessages\[1\]/);
 const exhausted=await run(['sprint','--json'],Array(20).fill({values:[{id:1,name:'A',state:'active'}],isLast:false}));assert.equal(exhausted.value.code,'response_too_large');assert.equal(exhausted.calls.length,20);
});
test('assignee me preserves identity before secret refusal and normalizes only preview strings',async()=>{
 let calls=0,out='';const exit=await main(['create','--summary','New','--type','Task','--assignee','me','--yes','--json'],{env,stdin:{isTTY:true,read:()=>''},fetch:async()=>{calls++;return Response.json({accountId:'DUMMY_SECRET',displayName:'Reader'});},write:s=>out+=s});assert.equal(exit,1);assert.equal(JSON.parse(out).code,'security');assert.equal(calls,1);
});
test('control refusal TOON and JSON goldens, preview and apply, exit one and no requests',async()=>{
 for(const json of [false,true])for(const yes of [false,true]){let output='',calls=0;const exit=await main(['comment','DEMO-1','--file=-',...(json?['--json']:[]),...(yes?['--yes']:[])],{env,stdin:{isTTY:true,read:()=>String.fromCharCode(27)+'[31mred'},fetch:async()=>{calls++;return Response.json({key:'DEMO-1',fields:{summary:'Old'}});},write:s=>output+=s});assert.equal(exit,1);assert.equal(calls,0);assert.equal(output,readFileSync(new URL('goldens/control-refusal'+(json?'-json':'')+'.txt',import.meta.url),'utf8'));}
});
test('launcher failure is stdout-only and secret safe',()=>{
 const r=spawnSync(process.execPath,['--import',new URL('./reject-build.ts',import.meta.url).href,new URL('../../bin/jira-axi',import.meta.url).pathname,'--json'],{env,encoding:'utf8'});assert.equal(r.status,1);assert.equal(r.stderr,'');assert.equal(JSON.parse(r.stdout).code,'transport_error');assert.ok(!r.stdout.includes('DUMMY_SECRET'));
});
