import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToAdf } from '../markdown-adf.ts';

test('bare URL sentence punctuation stays outside ADF link text and href',()=>{
 for(const suffix of [';', '.', ',', ')', ');', '.,']) {
  const href='https://example.com/pull/1';
  const result=markdownToAdf(href+suffix);
  assert.deepEqual(result.doc.content[0]!.content,[
   {type:'text',text:href,marks:[{type:'link',attrs:{href}}]},
   {type:'text',text:suffix},
  ]);
 }
 const href='https://example.com/wiki/Thing_(detail)';
 assert.deepEqual(markdownToAdf(href+').').doc.content[0]!.content,[
  {type:'text',text:href,marks:[{type:'link',attrs:{href}}]},
  {type:'text',text:').' },
 ]);
});
