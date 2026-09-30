import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {run} from './rest-harness.ts';
const fixture=(n:string)=>JSON.parse(readFileSync(new URL(`fixtures/${n}.json`,import.meta.url),'utf8'));
export async function restGoldens():Promise<Record<string,string>>{
 const issue=fixture('issue-view');const comments=issue.fields.comment;
 const outputs:Record<string,string>={};
 for(const [name,args,data]of [
  ['rest-issue',['issue',issue.key],[issue,{...comments,comments:[...comments.comments].reverse()}]],
  ['rest-issue-json',['issue',issue.key,'--json'],[issue,{...comments,comments:[...comments.comments].reverse()}]],
  ['rest-list',['list','--assignee','me'],[fixture('rest-search')]],
  ['rest-list-json',['list','--assignee','me','--json'],[fixture('rest-search')]],
  ['rest-sprint',['sprint'],[fixture('rest-sprints')]],
  ['rest-sprint-json',['sprint','--json'],[fixture('rest-sprints')]],
  ['rest-me',['me'],[fixture('rest-myself'),fixture('rest-board')]],
  ['rest-me-json',['me','--json'],[fixture('rest-myself'),fixture('rest-board')]],
 ] as [string,string[],unknown[]][]){const result=await run(args,data);assert.equal(result.exit,0,result.output);outputs[name]=result.output;}
 return outputs;
}
test('REST output locks v3 JSON and matches renderer TOON goldens',async()=>{
 const outputs=await restGoldens();
 for(const [name,output]of Object.entries(outputs))assert.equal(output,readFileSync(new URL(`goldens/${name}.txt`,import.meta.url),'utf8'),name);
 for(const [rest,legacy]of [['rest-issue','issue'],['rest-list','list'],['rest-sprint','sprint']])assert.equal(outputs[rest!],readFileSync(new URL(`goldens/${legacy}.txt`,import.meta.url),'utf8'));
});
