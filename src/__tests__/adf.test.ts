import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adfToText, flattenWikiMarkup, truncate } from '../adf.ts';

const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content });
const p = (...content: unknown[]) => ({ type: 'paragraph', content });
const t = (text: string, marks?: unknown[]) => ({ type: 'text', text, ...(marks ? { marks } : {}) });

test('flattens paragraphs and drops formatting marks', () => {
  const out = adfToText(doc(p(t('Hello ')), p(t('world', [{ type: 'strong' }]))));
  assert.equal(out, 'Hello\n\nworld');
});

test('keeps code marks and renders links with their href', () => {
  assert.equal(adfToText(doc(p(t('npm run build', [{ type: 'code' }])))), '`npm run build`');
  assert.equal(
    adfToText(doc(p(t('docs', [{ type: 'link', attrs: { href: 'https://example.test/d' } }])))),
    'docs (https://example.test/d)',
  );
});

test('renders bullet and ordered lists', () => {
  const out = adfToText(
    doc(
      { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('one'))] }, { type: 'listItem', content: [p(t('two'))] }] },
      { type: 'orderedList', content: [{ type: 'listItem', content: [p(t('first'))] }] },
    ),
  );
  assert.equal(out, '- one\n- two\n1. first');
});

test('renders headings, code blocks, rules, quotes and tables', () => {
  assert.equal(adfToText(doc({ type: 'heading', attrs: { level: 2 }, content: [t('Title')] })), '## Title');
  assert.equal(
    adfToText(doc({ type: 'codeBlock', attrs: { language: 'ts' }, content: [t('const a = 1;')] })),
    '```ts\nconst a = 1;\n```',
  );
  assert.equal(adfToText(doc({ type: 'rule' })), '---');
  assert.equal(adfToText(doc({ type: 'blockquote', content: [p(t('quoted'))] })), '> quoted');
  assert.equal(
    adfToText(
      doc({
        type: 'table',
        content: [
          { type: 'tableRow', content: [{ type: 'tableHeader', content: [p(t('a'))] }, { type: 'tableHeader', content: [p(t('b'))] }] },
          { type: 'tableRow', content: [{ type: 'tableCell', content: [p(t('1'))] }, { type: 'tableCell', content: [p(t('2'))] }] },
        ],
      }),
    ),
    'a | b\n1 | 2',
  );
});

test('renders mentions, status lozenges, task lists and media placeholders', () => {
  assert.equal(adfToText(doc(p({ type: 'mention', attrs: { text: '@Ada' } }))), '@Ada');
  assert.equal(adfToText(doc(p({ type: 'status', attrs: { text: 'BLOCKED' } }))), '[BLOCKED]');
  assert.equal(
    adfToText(
      doc({
        type: 'taskList',
        content: [
          { type: 'taskItem', attrs: { state: 'DONE' }, content: [t('done')] },
          { type: 'taskItem', attrs: { state: 'TODO' }, content: [t('todo')] },
        ],
      }),
    ),
    '[x] done\n[ ] todo',
  );
  assert.equal(adfToText(doc({ type: 'mediaSingle', attrs: { alt: 'shot.png' } })), '[attachment: shot.png]');
});

test('hardBreak becomes a newline and blank runs collapse', () => {
  const out = adfToText(doc(p(t('a'), { type: 'hardBreak' }, t('b')), p(), p(), p(t('c'))));
  assert.equal(out, 'a\nb\n\nc');
});

test('tolerates null, strings and unknown node types', () => {
  assert.equal(adfToText(null), '');
  assert.equal(adfToText(undefined), '');
  assert.equal(adfToText('plain body'), 'plain body');
  assert.equal(adfToText(doc({ type: 'futureNode', content: [p(t('still readable'))] })), 'still readable');
});

test('flattens server-side wiki markup', () => {
  assert.equal(flattenWikiMarkup('h2. Title'), '## Title');
  assert.equal(flattenWikiMarkup('see [docs|https://x.test]'), 'see docs (https://x.test)');
  assert.equal(flattenWikiMarkup('{code:js}x{code}'), '```x```');
});

test('truncate reports the drop and prefers a word boundary', () => {
  const text = 'alpha beta gamma delta epsilon';
  const r = truncate(text, 20);
  assert.equal(r.truncated, true);
  assert.equal(r.fullLength, text.length);
  assert.ok(!r.text.endsWith(' '));
  assert.ok(text.startsWith(r.text));
  assert.deepEqual(truncate('short', 20), { text: 'short', truncated: false, fullLength: 5 });
  assert.equal(truncate(text, 0).text, text, 'limit 0 means unlimited');
});
