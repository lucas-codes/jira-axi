import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseIssue, parseIssueList } from '../model.ts';
import { renderIssue, renderIssueList, renderSprints } from '../render.ts';
import { Out, csvCell } from '../format.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));
const OPTS = { baseUrl: 'https://example.atlassian.net' };

test('csv cells quote only what would be ambiguous, using real TOON escaping', () => {
  // A bare space is not ambiguous in TOON (only the delimiter, `,`, is) — quoting
  // it anyway would waste tokens for no safety gain.
  assert.equal(csvCell('DEMO-1'), 'DEMO-1');
  assert.equal(csvCell('In Progress'), 'In Progress');
  assert.equal(csvCell('a,b'), '"a,b"');
  // TOON escapes with backslashes, not doubled quotes (CSV) — a real TOON
  // decoder does not understand `""` as an escaped quote.
  assert.equal(csvCell('say "hi"'), '"say \\"hi\\""');
  // A literal newline must round-trip via `\n`, not collapse to a space and
  // lose information.
  assert.equal(csvCell('one\ntwo'), '"one\\ntwo"');
  assert.equal(csvCell(null), '-');
  assert.equal(csvCell(''), '-');
  assert.equal(csvCell(7), '7');
  // Structural / literal-lookalike values that TOON must quote to stay
  // unambiguous on decode.
  assert.equal(csvCell('12:30'), '"12:30"');
  assert.equal(csvCell('-1'), '"-1"');
  assert.equal(csvCell('true'), '"true"');
  assert.equal(csvCell('null'), '"null"');
  assert.equal(csvCell('3.14'), '"3.14"');
  assert.equal(csvCell('a[b]'), '"a[b]"');
  assert.equal(csvCell('a\\b'), '"a\\\\b"');
});

test('Out emits the axi block shapes', () => {
  const out = new Out()
    .kv('key', 'DEMO-1')
    .kv('missing', undefined)
    .table('issues', ['key', 'status'], [['DEMO-1', 'To Do']])
    .list('help', ['do a thing'])
    .text('description', 'line one\nline two');
  assert.equal(
    out.toString(),
    ['key: DEMO-1', 'missing: -', 'issues[1]{key,status}:', '  DEMO-1,To Do', 'help[1]:', '  do a thing', 'description:', '  line one', '  line two'].join('\n'),
  );
});

test('compact issue view is far smaller than the raw CLI payload', () => {
  const raw = readFileSync(join(here, 'fixtures', 'issue-view.json'), 'utf8');
  const issue = parseIssue(fixture('issue-view.json'), OPTS);
  const text = renderIssue(issue, { full: false, comments: false });
  assert.ok(text.length < raw.length / 4, `expected big shrink, got ${text.length} vs ${raw.length}`);
  assert.match(text, /^key: DEMO-101$/m);
  assert.match(text, /^type: Task$/m);
  assert.match(text, /^status: In Progress$/m);
  // The URL contains `:` (a structural TOON character), so a correct encoder quotes it.
  assert.match(text, /^url: "https:\/\/example\.atlassian\.net\/browse\/DEMO-101"$/m);
  assert.match(text, /^help\[\d+\]:$/m);
});

test('the default view truncates the description and says so', () => {
  const issue = parseIssue(fixture('issue-view.json'), OPTS);
  const compact = renderIssue(issue, { full: false, comments: false });
  assert.match(compact, /^description\[\d+\/\d+ chars\]:$/m);
  const full = renderIssue(issue, { full: true, comments: true });
  assert.match(full, /^description:$/m);
  assert.ok(full.length > compact.length);
  assert.match(full, /^reporter: /m);
});

test('--full removes the truncation markers entirely', () => {
  const issue = parseIssue(fixture('issue-view-comments.json'), OPTS);
  const full = renderIssue(issue, { full: true, comments: true });
  assert.doesNotMatch(full, /\[\d+\/\d+ chars\]/);
});

test('comments render as author/date blocks only when asked', () => {
  const issue = parseIssue(fixture('issue-view-comments.json'), OPTS);
  const without = renderIssue(issue, { full: false, comments: false });
  assert.match(without, /^comments: 7$/m);
  assert.match(without, /--comments/);

  const withThem = renderIssue(issue, { full: false, comments: true });
  assert.match(withThem, /^comments\[3\/7\]:$/m);
  // A plain space is not ambiguous in TOON, so the author name stays unquoted.
  assert.match(withThem, /^ {2}\d{4}-\d{2}-\d{2} Alex Example/m);
});

test('a capped comment set is labelled shown/total', () => {
  const issue = parseIssue(fixture('issue-view-comments.json'), OPTS);
  issue.comments = issue.comments.slice(-1);
  const text = renderIssue(issue, { full: false, comments: true });
  assert.match(text, /^comments\[1\/7\]:$/m);
});

test('list renders a table and a next-step hint', () => {
  const issues = parseIssueList(fixture('issue-list.json'), OPTS);
  const text = renderIssueList(issues, { full: false, query: 'assignee=me' });
  assert.match(text, /^query: assignee=me$/m);
  assert.match(text, new RegExp(`^issues\\[${issues.length}\\]\\{key,type,status,assignee,summary\\}:$`, 'm'));
  assert.match(text, /jira-axi issue DEMO-\d+/);
  assert.equal(text.split('\n').filter((l) => l.startsWith('help[')).length, 1);
  const lines = text.split('\n').filter((l) => l.startsWith('  DEMO-'));
  assert.equal(lines.length, issues.length);
  for (const l of lines) assert.equal(l.length <= 160, true, `row too wide: ${l}`);
});

test('list --full widens the columns', () => {
  const issues = parseIssueList(fixture('issue-list.json'), OPTS);
  const text = renderIssueList(issues, { full: true, query: 'q' });
  assert.match(text, /\{key,type,status,priority,assignee,updated,labels,summary\}/);
});

test('an empty list explains itself instead of printing nothing', () => {
  const text = renderIssueList([], { full: false, query: 'assignee=nobody' });
  assert.match(text, /^issues\[0\]\{/m);
  assert.match(text, /No issues matched/);
});

test('sprints render as a table', () => {
  const text = renderSprints([{ id: '1', name: 'Sprint 41', state: 'active', start: '2026-09-01', end: '2026-09-15' }]);
  assert.match(text, /^sprints\[1\]\{id,name,state,start,end\}:$/m);
  // `id: '1'` looks like a number, so it must be quoted to decode back as a
  // string; `Sprint 41` has only a space (not ambiguous), so it stays bare.
  assert.match(text, /^ {2}"1",Sprint 41,active,2026-09-01,2026-09-15$/m);
});
