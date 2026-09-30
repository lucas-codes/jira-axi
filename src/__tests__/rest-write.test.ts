import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../index.ts';
import { write } from '../api.ts';
import { markdownToAdf } from '../markdown-adf.ts';
import { adfToText } from '../adf.ts';
const env={ATLASSIAN_EMAIL:'reader@example.com',ATLASSIAN_API_TOKEN:'DUMMY_SECRET',ATLASSIAN_SITE:'example.atlassian.net',JIRA_PROJECT:'DEMO',JIRA_BOARD:'42'};
const target={key:'DEMO-1',fields:{summary:'Old',priority:{name:'Low'},labels:['old'],components:[{name:'Old'}],assignee:{displayName:'Other'},parent:{key:'DEMO-2'}}};
async function run(args:string[],responses:unknown[]=[target],body='Hello **world**',writeStatus=201){let output='';const calls:{url:string;init?:RequestInit}[]=[];const exit=await main([...args,'--json'],{env,stdin:{isTTY:true,read:()=>body},fetch:async(url,init)=>{calls.push({url:String(url),init});const mutation=init?.method!=='GET';return mutation?(writeStatus===204?new Response(null,{status:204}):Response.json(responses.shift()??{id:'99',key:'DEMO-99'},{status:writeStatus})):Response.json(responses.shift());},write:s=>output+=s});return{exit,output,calls,value:JSON.parse(output)};}
test('comment previews same request as send; internal and digest gate',async()=>{
 const args=['comment','DEMO-1','--file=-','--internal'];const preview=await run(args);assert.equal(preview.exit,0,preview.output);assert.equal(preview.calls.length,1);assert.equal(preview.value.applied,false);assert.match(preview.value.payloadDigest,/^[a-f0-9]{12}$/);assert.equal(preview.value.target,'Old');assert.deepEqual(preview.value.request.body,{body:markdownToAdf('Hello **world**').doc,properties:[{key:'sd.public.comment',value:{internal:true}}]});
 const applied=await run([...args,'--yes','--confirm',preview.value.payloadDigest]);assert.equal(applied.exit,0,applied.output);assert.equal(applied.value.commentId,'99');assert.equal(applied.value.chars,'Hello **world**'.length);assert.deepEqual(JSON.parse(applied.calls[1]!.init!.body as string),preview.value.request.body);assert.equal(applied.calls[1]!.init?.method,'POST');assert.equal((applied.calls[1]!.init?.headers as Record<string,string>)['Content-Type'],'application/json');
 for(const flags of [['--confirm',preview.value.payloadDigest],['--yes','--confirm','bad'],['--yes','--confirm','000000000000']]){const r=await run([...args,...flags]);assert.equal(r.exit,2);assert.ok(r.calls.every(c=>c.init?.method==='GET'));assert.equal(r.value.applied,false);}
});
test('terminal-control source refuses preview and apply before any request',async()=>{
 for(const yes of [false,true])for(const [field,args,body]of [
  ['comment',['comment','DEMO-1','--file=-'],'one '+String.fromCharCode(27)+'[31mred'],
  ['description',['edit','DEMO-1','--file=-'],'one '+String.fromCharCode(27)],
  ...['summary','type','priority','assignee','parent','project','label','component'].map(flag=>[flag,['create','--summary','New','--type','Task','--'+flag,'Bad'+String.fromCharCode(27)],''] as [string,string[],string]),
 ] as [string,string[],string][]){
  const r=await run([...args,...(yes?['--yes']:[])],[target],body);assert.equal(r.exit,1,r.output);assert.equal(r.value.code,'security');assert.equal(r.value.applied,false);assert.equal(r.calls.length,0);assert.match(r.value.error,/U\+001B/);assert.ok(!r.output.includes(String.fromCharCode(27)));assert.ok(r.value.help[0].includes(field==='label'?'labels':field==='component'?'components':field));
 }
});
test('allowed body newlines and tabs stay byte-equal in preview request and apply',async()=>{
 const args=['comment','DEMO-1','--file=-'];const body='\x60\x60\x60ts\nconst value = 1;\n\tvalue++;\n\x60\x60\x60';
 const preview=await run(args,[target],body);const applied=await run([...args,'--yes'],[target],body);
 assert.equal(preview.exit,0,preview.output);assert.equal(applied.exit,0,applied.output);
 assert.deepEqual(JSON.parse(applied.calls[1]!.init!.body as string),preview.value.request.body);
});
test('create every field resolves user before preview then POST',async()=>{
 const args=['create','--summary','New','--type','Task','--project','other','--file=-','--parent','2','--priority','High','--assignee','Sam','--label','a,b','--component','C,D'];
 const users=[{accountId:'sam-id',displayName:'Sam',active:true}];const preview=await run(args,[users]);assert.equal(preview.exit,0,preview.output);assert.equal(new URL(preview.calls[0]!.url).searchParams.get('project'),'OTHER');assert.deepEqual(preview.value.request.body.fields,{project:{key:'OTHER'},issuetype:{name:'Task'},summary:'New',description:markdownToAdf('Hello **world**').doc,parent:{key:'OTHER-2'},priority:{name:'High'},assignee:{accountId:'sam-id'},labels:['a','b'],components:[{name:'C'},{name:'D'}]});
 const applied=await run([...args,'--yes'],[users,{id:'99',key:'DEMO-99'}]);assert.equal(applied.value.key,'DEMO-99');assert.equal(applied.value.url,'https://example.atlassian.net/browse/DEMO-99');assert.equal(applied.calls.length,2);
});
test('edit one atomic PUT fields, update removals and notify query affect digest',async()=>{
 const args=['edit','DEMO-1','--summary','New','--priority','High','--assignee','x','--parent','3','--label=-old,new','--component=-Old,New'];
 const preview=await run(args);assert.equal(preview.exit,0,preview.output);assert.deepEqual(preview.value.request.body,{fields:{summary:'New',priority:{name:'High'},assignee:null,parent:{key:'DEMO-3'}},update:{labels:[{remove:'old'},{add:'new'}],components:[{remove:{name:'Old'}},{add:{name:'New'}}]}});
 const notify=await run([...args,'--skip-notify']);assert.notEqual(preview.value.payloadDigest,notify.value.payloadDigest);assert.deepEqual(notify.value.request.query,{notifyUsers:'false'});
 const applied=await run([...args,'--skip-notify','--yes'],[target],'',204);assert.equal(applied.exit,0,applied.output);assert.equal(applied.calls.length,2);assert.equal(applied.calls[1]!.init?.method,'PUT');assert.equal(new URL(applied.calls[1]!.url).searchParams.get('notifyUsers'),'false');
});
test('assignee me on create uses myself, previews resolved identity and leaves stdin alone on edit',async()=>{
 const created=await run(['create','--summary','New','--type','Task','--assignee','me'],[{accountId:'me-id',displayName:'Reader'}]);assert.equal(created.exit,0,created.output);assert.equal(created.value.request.body.fields.assignee.accountId,'me-id');assert.equal(created.value.assignee,'Reader (me-id)');
 let output='';const exit=await main(['edit','DEMO-1','--priority','High','--json'],{env,stdin:{isTTY:false,read:()=>{throw Error('edit must not read stdin without an explicit body flag');}},fetch:async()=>Response.json(target),write:s=>output+=s});assert.equal(exit,0,output);
});
test('unsafe content, keys, moved targets and user response shapes stop writes',async()=>{
 for(const body of ['DUMMY_SECRET','DUMMY_\x1b[31mSECRET']){const r=await run(['comment','DEMO-1','--file=-','--yes'],[target],body);assert.equal(r.exit,1);assert.equal(r.value.applied,false);assert.ok(r.calls.every(c=>c.init?.method==='GET'));}
 for(const key of ['DEMO-0','A-1','../DEMO-1']){const r=await run(['comment',key,'--file=-','--yes']);assert.equal(r.exit,2);assert.equal(r.calls.length,0);}
 for(const command of ['comment','edit']){const r=await run([command,'DEMO-1',...(command==='comment'?['--file=-']:['--priority','High']),'--yes'],[{key:'DEMO-2',fields:{}}]);assert.equal(r.value.code,'issue_moved');assert.match(r.value.error,/DEMO-2/);assert.equal(r.calls.length,1);}
 for(const users of [{},[{active:true}], [{accountId:'id',active:true,displayName:4}]]){const r=await run(['create','--summary','New','--type','Task','--assignee','Sam','--yes'],[users]);assert.equal(r.value.code,'bad_response');}
 for(const users of [[],[{accountId:'a',active:false,displayName:'Sam'}]])assert.equal((await run(['create','--summary','New','--type','Task','--assignee','Sam'],[users])).value.code,'not_found');
 const ambiguous=await run(['create','--summary','New','--type','Task','--assignee','Sam'],[[{accountId:'a',active:true,displayName:'Sam'},{accountId:'b',active:true,displayName:'Sam'}]]);assert.equal(ambiguous.value.code,'ambiguous_user');
});
test('write outcomes never retry and applied is classified',async()=>{
 for(const [status,code,applied]of [[400,'rejected',false],[401,'unauthorized',false],[403,'forbidden',false],[404,'not_found',false],[429,'rate_limited',false],[500,'write_outcome_unknown','unknown'],[200,'write_outcome_unknown','unknown'],[303,'security','unknown']] as const){const r=await run(['comment','DEMO-1','--file=-','--yes'],[target,{errors:{priority:'DUMMY_\x1b[31mSECRET'},errorMessages:['Bad']}],'Hello',status);assert.equal(r.value.code,code,r.output);assert.equal(r.value.applied,applied);assert.equal(r.calls.length,2);assert.ok(!r.output.includes('DUMMY_SECRET'));if(status===400)assert.equal(r.value.fields[0].message,'[redacted]');}
 const bad=await run(['comment','DEMO-1','--file=-','--yes'],[target,{}]);assert.equal(bad.value.applied,'unknown');assert.equal(bad.value.code,'write_outcome_unknown');
});
test('a successful write followed by stdout refusal never claims unapplied',async()=>{
 const r=await run(['comment','DEMO-1','--file=-','--yes'],[target,{id:'x'.repeat(600000)}]);assert.equal(r.exit,1);assert.equal(r.value.code,'output_too_large');assert.equal(r.value.applied,true);assert.equal(r.calls.length,2);assert.ok(r.output.length<512*1024);
});
test('serialized output leak refusal preserves a known successful write outcome',async()=>{
 let out='',calls=0;const exit=await main(['comment','DEMO-1','--file=-','--yes','--json'],{env:{...env,ATLASSIAN_API_TOKEN:'commentId'},stdin:{isTTY:true,read:()=> 'Hello'},fetch:async(_url,init)=>{calls++;return init?.method==='GET'?Response.json(target):Response.json({id:'a'},{status:201});},write:s=>out+=s});assert.equal(exit,1);assert.equal(calls,2);const result=JSON.parse(out);assert.equal(result.code,'security');assert.equal(result.applied,true);assert.ok(!out.includes('commentId'));
});
test('Markdown subset round trips normalized text and discloses unsupported outside code',()=>{
 for(const [md,text]of [['# Heading',' # Heading'.trim()],['one\ntwo','one\ntwo'],['**bold** *em* _em_ ~~strike~~ `code`','bold em em strike `code`'],['[anchor](https://github.com/x)','anchor (https://github.com/x)'],['https://github.com/x','https://github.com/x'],['a_b \\*literal\\*','a_b *literal*'],['_foo_bar_','foo_bar'],['**a\\*b**','a*b'],['3. first\n4. second','3. first\n4. second'],['- outer\n    - inner','- outer\n\n    - inner'],['> quoted\n> words','> quoted\nwords'],['---','---'],['```ts\nlet x=1','```ts\nlet x=1\n```']] as [string,string][]){const converted=markdownToAdf(md);assert.equal(adfToText(converted.doc),text,md);assert.deepEqual(converted.unsupported,[]);}
 assert.equal(adfToText(markdownToAdf('one\n\ntwo').doc),'one\n\ntwo');
 assert.deepEqual(markdownToAdf('**<b> ![image](x)**').unsupported,['html','image']);
 assert.deepEqual(markdownToAdf('**`<b>`**').unsupported,[]);
 const converted=markdownToAdf('a | b\n--- | ---\n<img> ![img](x) [bad](javascript:a)\n```\n<img>\n```');assert.deepEqual(converted.unsupported,['table','html','image','link']);assert.match(adfToText(converted.doc),/javascript:a/);
});
function typeOnly() {
 // @ts-expect-error An ungated write must not typecheck.
 write({method:'POST',path:'/rest/api/3/issue',query:{},body:{}}, {env,fetch});
}
