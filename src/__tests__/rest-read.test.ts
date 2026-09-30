import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { run } from './rest-harness.ts';
import { buildJql } from '../jql.ts';
import { parseArgs } from '../args.ts';
import { adfToText } from '../adf.ts';
const fixture=(n:string)=>JSON.parse(readFileSync(new URL(`fixtures/${n}.json`,import.meta.url),'utf8'));
test('issue uses bounded comment page, newest reversed, goldens unchanged',async()=>{
 const issue=fixture('issue-view-comments');const page=issue.fields.comment;delete issue.fields.comment;
 for(const flags of [[],['--comments'],['--full'],['--comments','101']]){const r=await run(['issue','demo-101',...flags,'--json'],[issue,{...page,comments:[...page.comments].reverse()}]);assert.equal(r.exit,0,r.output);assert.equal(r.calls.length,2);const url=new URL(r.calls[1]!.url);assert.equal(url.searchParams.get('orderBy'),'-created');assert.equal(url.searchParams.get('maxResults'),flags.includes('--full')||flags.includes('101')?'100':flags.length?'10':'1');assert.deepEqual(r.value.comments.map((c:{id:string})=>c.id),page.comments.map((c:{id:string})=>c.id));}
});
test('REST search is one page, empty success; schemas fail closed',async()=>{
 const r=await run(['list','--assignee','me','--json'],[fixture('rest-search')]);assert.equal(r.exit,0,r.output);assert.equal(r.calls.length,1);assert.match(new URL(r.calls[0]!.url).searchParams.get('jql')!,/currentUser\(\)/);
 const empty=await run(['list'],[{issues:[],isLast:true}]);assert.equal(empty.exit,0);assert.match(empty.output,/No issues matched/);
 for(const data of [null,{issues:null,isLast:true},{issues:[],isLast:0},{issues:[{key:'DEMO-1',fields:null}],isLast:true}])assert.equal((await run(['list','--json'],[data])).value.code,'bad_response');
 for(const data of [{comments:null,total:0},{comments:[],total:0.1},{comments:[{body:{}}],total:1}])assert.equal((await run(['issue','DEMO-1','--json'],[{key:'DEMO-1',fields:{}},data])).value.code,'bad_response');
});
test('sprint paging and picks, empty windows and kanban refusal',async()=>{
 const pages=[{values:[{id:1,name:'Old',state:'active'}],isLast:false},{values:[{id:2,name:'New',state:'active'}],isLast:true}];
 const r=await run(['list','--type','Task','--sprint','current','--json'],[...pages,{issues:[],isLast:true}]);assert.equal(r.exit,0,r.output);assert.equal(new URL(r.calls[1]!.url).searchParams.get('startAt'),'1');assert.match(new URL(r.calls[2]!.url).searchParams.get('jql')!,/type="Task" AND sprint = 2/);
 assert.equal((await run(['sprint','--json'],[{values:[],isLast:true}])).exit,0);
 const empty=await run(['list','--sprint','next','--json'],[{values:[],isLast:true}]);assert.equal(empty.value.code,'not_found');assert.match(empty.value.error,/42.*future/);assert.equal(empty.calls.length,1);
 for(const page of [{values:[],isLast:false},{values:[{name:'Bad',state:'active'}],isLast:true}])assert.equal((await run(['sprint','--json'],[page])).value.code,'bad_response');
 assert.equal((await run(['sprint','--json'],[fixture('rest-kanban')],400)).value.code,'unsupported');
 assert.equal((await run(['sprint','--project','XX','--json'])).exit,2);
 assert.equal((await run(['sprint','--state','bad','--json'])).exit,2);
});
test('JQL port filters, dates, raw precedence and outside-quote ordering',()=>{
 const cases:[string[],string][]=[
 [[], 'project="DEMO" ORDER BY created DESC'],
 [['--created','0026-02-28'], 'project="DEMO" AND createdDate>="0026-02-28" AND createdDate<"0026-03-01" ORDER BY created DESC'],
 [['--type','x','--priority','~x','--assignee','~ Bob'], 'project="DEMO" AND type IS EMPTY AND priority IS NOT EMPTY AND assignee!="Bob" ORDER BY created DESC'],
 [['--label','a,~b','--status','Open,~Closed'], 'project="DEMO" AND labels IN ("a") AND labels NOT IN ("b") AND status IN ("Open") AND status NOT IN ("Closed") ORDER BY created DESC'],
 [['--updated','2026/09/30 03:04'], 'project="DEMO" AND updatedDate>="2026/09/30 03:04" AND updatedDate<"2026/10/01 03:04" ORDER BY updated DESC'],
 [['--created','today','--watching','--history'], 'project="DEMO" AND issue IN issueHistory() AND issue IN watchedIssues() AND createdDate>=startOfDay() ORDER BY lastViewed DESC'],
 [['--jql','a OR b ORDER BY priority ASC','--type','Task'], 'project="DEMO" AND (a OR b) AND type="Task" ORDER BY priority ASC'],
 [['--jql','project=XX OR a','--type','Task'], '(project=XX OR a) AND type="Task" ORDER BY created DESC'],
 [['--jql','summary ~ "ORDER BY abc"'], 'project="DEMO" AND (summary ~ "ORDER BY abc") ORDER BY created DESC'],
 ];for(const [argv,expected]of cases)assert.equal(buildJql(parseArgs(['list',...argv]),'DEMO'),expected);
 for(const raw of ['a OR b','project=XX OR a']){const r=buildJql(parseArgs(['list','--jql',raw,'--type','Task']),'DEMO',4);assert.match(r,/type="Task" AND sprint = 4/);assert.equal(r.startsWith('project="DEMO"'),!raw.startsWith('project='));}
});
test('ADF roots, node attributes, depth/count and safe external links',()=>{
 for(const body of [{},[],{type:'doc',version:2,content:[]},{type:'doc',version:1,content:[{type:'text',attrs:null}]}])assert.throws(()=>adfToText(body),{code:'bad_response'});
 const doc=(content:unknown[])=>({type:'doc',version:1,content});
 for(const node of [{type:''},{type:'heading',attrs:{level:'2'}},{type:'orderedList',attrs:{order:1.5}},{type:'inlineCard',attrs:{url:3}},{type:'text',marks:[{type:'link',attrs:{href:3}}]}]) assert.throws(()=>adfToText(doc([node])),{code:'bad_response'});
 assert.equal(adfToText(doc([{type:'extension'}])),'[unsupported: extension]');
 for(const href of ['javascript:a','data:a','file:a','https://x@a.test','https://a.test/\n']){const s=adfToText(doc([{type:'paragraph',content:[{type:'text',text:'Anchor',marks:[{type:'link',attrs:{href}}]}]},{type:'inlineCard',attrs:{url:href}}]));assert.match(s,/link omitted/);assert.match(s,/card omitted/);}
 assert.match(adfToText(doc([{type:'inlineCard',attrs:{url:'https://github.com/x'}}])),/github/);
 assert.equal(adfToText(doc([{type:'paragraph',content:[{type:'unknownLeaf'}]}])),'[unsupported: unknownLeaf]');
 assert.equal(adfToText(doc([{type:'paragraph',content:[{type:'unknownContainer',content:[{type:'text',text:'readable'}]}]}])),'readable');
 let nested:unknown={type:'text',text:'a'};for(let i=0;i<66;i++)nested={type:'paragraph',content:[nested]};assert.throws(()=>adfToText(doc([nested])),{code:'bad_response'});assert.throws(()=>adfToText(doc(Array(100000).fill({type:'hardBreak'}))),{code:'bad_response'});
});
