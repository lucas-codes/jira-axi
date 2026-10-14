import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../index.ts';
import { env } from './rest-harness.ts';
import { validateUrl } from '../api.ts';

const blocks = { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' };
const relates = { id: '10003', name: 'Relates', inward: 'relates to', outward: 'relates to' };
const entry = (direction = 'outward', type = blocks) => ({ id: '133547', type, [`${direction}Issue`]: { key: 'ED-2', fields: { summary: 'Second issue', status: { name: 'Done' } } } });
interface Scenario {
  types?: unknown;
  before?: unknown[];
  after?: unknown[];
  postStatus?: number;
  readBackStatus?: number;
  metadataStatus?: number;
  deleteStatus?: number;
  token?: string;
}
async function run(args: string[], scenario: Scenario = {}, json = true) {
  const calls: { method: string; path: string; body: unknown; fields: string | null }[] = [];
  let output = '';
  let posted = false;
  const exit = await main([...args, ...(json ? ['--json'] : [])], {
    env: { ...env, ...(scenario.token ? { ATLASSIAN_API_TOKEN: scenario.token } : {}) },
    stdin: { isTTY: true, read: () => '' }, write: s => { output += s; },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      calls.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null, fields: url.searchParams.get('fields') });
      if (method === 'POST') {
        posted = true;
        return new Response(null, { status: scenario.postStatus ?? 201 });
      }
      if (method === 'DELETE') return new Response(null, { status: scenario.deleteStatus ?? 204 });
      if (url.pathname === '/rest/api/3/issueLinkType') return Response.json(scenario.types ?? { issueLinkTypes: [blocks, relates] });
      if (url.pathname === '/rest/api/3/issueLink/133547') return Response.json({ id: '133547', type: blocks, inwardIssue: { key: 'ED-1' }, outwardIssue: { key: 'ED-2' } }, { status: scenario.metadataStatus ?? 200 });
      if (url.pathname.endsWith('/comment')) return Response.json({ comments: [], total: 0 });
      if (url.pathname === '/rest/api/3/issue/ED-1') return Response.json({ key: 'ED-1', fields: { summary: 'First', status: { name: 'Open' }, issuelinks: posted ? (scenario.after ?? [entry()]) : (scenario.before ?? []) } }, { status: posted ? (scenario.readBackStatus ?? 200) : 200 });
      throw new Error(`Unexpected ${method} ${url.pathname}`);
    },
  });
  return { exit, output, calls, value: json ? JSON.parse(output) : undefined };
}

test('link previews literal direction and payload for name, inward phrase and symmetric type', async () => {
  for (const [needle, type, outward, inward, reads, inverse, id] of [
    ['Blocks', 'Blocks', 'ED-1', 'ED-2', 'ED-1 blocks ED-2', 'ED-2 is blocked by ED-1', '10000'],
    ['IS BLOCKED BY', 'Blocks', 'ED-2', 'ED-1', 'ED-2 blocks ED-1', 'ED-1 is blocked by ED-2', '10000'],
    ['relates to', 'Relates', 'ED-1', 'ED-2', 'ED-1 relates to ED-2', 'ED-2 relates to ED-1', '10003'],
  ]) {
    const r = await run(['link', 'ED-1', 'ED-2', '--type', needle!]);
    assert.equal(r.exit, 0, r.output);
    assert.deepEqual({ action: r.value.action, type: r.value.type, outward: r.value.outward, inward: r.value.inward, reads: r.value.reads, inverse: r.value.inverse, applied: r.value.applied }, { action: 'link-issues', type, outward, inward, reads, inverse, applied: false });
    assert.deepEqual(r.value.request, { method: 'POST', path: '/rest/api/3/issueLink', query: {}, body: { type: { id }, inwardIssue: { key: outward }, outwardIssue: { key: inward } } });
    assert.deepEqual(r.calls.map(c => `${c.method} ${c.path}`), ['GET /rest/api/3/issue/ED-1', 'GET /rest/api/3/issueLinkType']);
  }
  const compact = await run(['link', 'ED-1', 'ED-2', '--type', 'Blocks'], {}, false);
  assert.match(compact.output, /^reads: ED-1 blocks ED-2$/m);
  assert.match(compact.output, /^applied: false$/m);
});

test('link applies an exact confirmed POST and reads the link id back', async () => {
  const preview = await run(['link', 'ED-1', 'ED-2', '--type', 'Blocks']);
  assert.equal(preview.value.payloadDigest, '9ad9e8818f88');
  const applied = await run(['link', 'ED-1', 'ED-2', '--type', 'Blocks', '--yes', '--confirm', preview.value.payloadDigest]);
  assert.equal(applied.exit, 0, applied.output);
  assert.deepEqual(applied.calls.filter(c => c.method === 'POST'), [{ method: 'POST', path: '/rest/api/3/issueLink', body: { type: { id: '10000' }, inwardIssue: { key: 'ED-1' }, outwardIssue: { key: 'ED-2' } }, fields: null }]);
  assert.deepEqual({ applied: applied.value.applied, linkId: applied.value.linkId, url: applied.value.url }, { applied: true, linkId: '133547', url: 'https://example.atlassian.net/browse/ED-1' });
  const inward = await run(['link', 'ED-1', 'ED-2', '--type', 'is blocked by', '--yes'], { after: [entry('inward')] });
  assert.equal(inward.value.linkId, '133547');
  assert.deepEqual(inward.calls.find(c => c.method === 'POST')!.body, { type: { id: '10000' }, inwardIssue: { key: 'ED-2' }, outwardIssue: { key: 'ED-1' } });
});

test('link rejects digest mismatch, self links and missing arguments without writing', async () => {
  for (const args of [
    ['link', 'ED-1', 'ED-2', '--type', 'Blocks', '--yes', '--confirm', '000000000000'],
    ['link', 'ED-1', 'ED-1', '--type', 'Blocks'], ['link', 'ED-1'], ['link', 'ED-1', 'ED-2'],
    ['link', 'ED-1', 'ED-2', '--type', 'blocks\u001b'],
  ]) {
    const r = await run(args);
    assert.equal(r.value.applied, false, r.output);
    assert.equal(r.value.code, args.at(-1) === 'blocks\u001b' ? 'security' : 'usage');
    assert.deepEqual(r.calls.filter(c => c.method !== 'GET'), []);
  }
});

test('unknown and ambiguous types list valid types, while matching multiple fields of one type is valid', async () => {
  const unknown = await run(['link', 'ED-1', 'ED-2', '--type', 'nope']);
  assert.equal(unknown.value.code, 'not_found');
  assert.equal(unknown.value.help[0], 'Available: Blocks (blocks / is blocked by); Relates (relates to / relates to). Pass --type with an exact name or phrase.');
  const ambiguous = await run(['link', 'ED-1', 'ED-2', '--type', 'blocks'], { types: { issueLinkTypes: [blocks, { ...relates, outward: 'blocks' }] } });
  assert.equal(ambiguous.value.code, 'ambiguous_link_type');
  assert.equal(ambiguous.value.help[0], 'Available: Blocks (blocks / is blocked by); Relates (blocks / relates to). Pass --type with an exact name or phrase.');
  const bad = await run(['link', 'ED-1', 'ED-2', '--type', 'Blocks'], { types: { issueLinkTypes: [{ id: '1', name: 'Blocks' }] } });
  assert.equal(bad.value.code, 'bad_response');
});

test('existing links prevent writes, but reverse directed links do not', async () => {
  for (const [type, before] of [['Blocks', entry()], ['Relates', entry('inward', relates)]] as const) {
    const r = await run(['link', 'ED-1', 'ED-2', '--type', type, '--yes'], { before: [before] });
    assert.deepEqual({ action: r.value.action, applied: r.value.applied, existing: r.value.existing, linkId: r.value.linkId }, { action: 'link-issues', applied: false, existing: true, linkId: '133547' });
    assert.deepEqual(r.calls.filter(c => c.method === 'POST'), []);
  }
  const reverse = await run(['link', 'ED-1', 'ED-2', '--type', 'Blocks', '--yes'], { before: [entry('inward')] });
  assert.equal(reverse.value.applied, true);
  assert.equal(reverse.calls.filter(c => c.method === 'POST').length, 1);
});

test('unknown writes and post-ack failures preserve applied outcome and read-back hint', async () => {
  for (const scenario of [{ postStatus: 500 }, { postStatus: 200 }]) {
    const r = await run(['link', 'ED-1', 'ED-2', '--type', 'Blocks', '--yes'], scenario);
    assert.equal(r.value.applied, 'unknown');
    assert.equal(r.value.code, 'write_outcome_unknown');
    assert.match(r.value.help[0], /Read back before retrying: jira-axi issue ED-1/);
    assert.equal(r.calls.filter(c => c.method === 'POST').length, 1);
  }
  for (const scenario of [{ after: [] }, { readBackStatus: 500 }, { token: 'linkId' }]) {
    const r = await run(['link', 'ED-1', 'ED-2', '--type', 'Blocks', '--yes'], scenario);
    assert.equal(r.value.applied, true, r.output);
    assert.match(r.value.help[0], /Read back before retrying: jira-axi issue ED-1/);
  }
});

test('unlink previews direction, confirms DELETE, handles missing and uncertain links', async () => {
  const preview = await run(['unlink', '133547']);
  assert.equal(preview.exit, 0, preview.output);
  assert.equal(preview.value.payloadDigest, '7ba4541d965b');
  assert.deepEqual(preview.value, { action: 'unlink-issues', payloadDigest: preview.value.payloadDigest, linkId: '133547', type: 'Blocks', outward: 'ED-1', inward: 'ED-2', reads: 'ED-1 blocks ED-2', inverse: 'ED-2 is blocked by ED-1', applied: false, request: { method: 'DELETE', path: '/rest/api/3/issueLink/133547', query: {} } });
  const applied = await run(['unlink', '133547', '--yes', '--confirm', preview.value.payloadDigest]);
  assert.equal(applied.value.applied, true);
  assert.deepEqual(applied.calls.filter(c => c.method === 'DELETE'), [{ method: 'DELETE', path: '/rest/api/3/issueLink/133547', body: null, fields: null }]);
  const gone = await run(['unlink', '133547', '--yes'], { metadataStatus: 404 });
  assert.equal(gone.value.code, 'not_found');
  assert.equal(gone.value.applied, false);
  assert.equal(gone.value.help[0], 'If an earlier unlink of it reported applied: unknown, that delete succeeded. Nothing was sent.');
  assert.deepEqual(gone.calls.filter(c => c.method === 'DELETE'), []);
  const unknown = await run(['unlink', '133547', '--yes'], { deleteStatus: 500 });
  assert.equal(unknown.value.applied, 'unknown');
  assert.match(unknown.value.help[0], /Read back before retrying: `jira-axi unlink 133547`/);
  const refused = await run(['unlink', '133547', '--yes'], { token: 'linkId' });
  assert.equal(refused.value.applied, true);
  assert.equal(refused.value.code, 'security');
});

test('unlink validates ids, flags and confirmation and reports raced deletes', async () => {
  for (const args of [['unlink'], ['unlink', '0'], ['unlink', 'ED-1'], ['unlink', '133547', '2'], ['unlink', '133547', '--type', 'Blocks'], ['unlink', '133547', '--confirm', '7ba4541d965b'], ['unlink', '133547', '--yes', '--confirm', '000000000000']]) {
    const r = await run(args);
    assert.equal(r.value.code, 'usage', r.output);
    assert.equal(r.value.applied, false);
    assert.deepEqual(r.calls.filter(c => c.method === 'DELETE'), []);
  }
  const raced = await run(['unlink', '133547', '--yes'], { deleteStatus: 404 });
  assert.equal(raced.value.error, 'Link 133547 was already deleted');
  assert.equal(raced.value.applied, false);
  const compact = await run(['unlink', '133547'], {}, false);
  assert.match(compact.output, /^reads: ED-1 blocks ED-2$/m);
  assert.match(compact.output, /^applied: false$/m);
});

test('link parsing rejects malformed lists, types, directions and linked issues', async () => {
  for (const types of [{}, { issueLinkTypes: {} }, { issueLinkTypes: [{ ...blocks, id: 1 }] }, { issueLinkTypes: [{ ...blocks, outward: '' }] }]) {
    const r = await run(['link', 'ED-1', 'ED-2', '--type', 'Blocks', '--yes'], { types });
    assert.equal(r.value.code, 'bad_response', r.output);
    assert.equal(r.value.applied, false);
  }
  for (const bad of [null, { ...entry(), id: '' }, { ...entry(), type: {} }, { ...entry(), inwardIssue: { key: 'ED-2' } }, { id: '1', type: blocks }, { ...entry(), outwardIssue: { key: '../other' } }]) {
    const r = await run(['link', 'ED-1', 'ED-2', '--type', 'Blocks', '--yes'], { before: [bad] });
    assert.equal(r.value.code, 'bad_response', r.output);
    assert.equal(r.value.applied, false);
    assert.deepEqual(r.calls.filter(c => c.method === 'POST'), []);
  }
});

test('link routes allow only the intended methods and query parameters', () => {
  for (const [method, path] of [['GET', '/rest/api/3/issueLinkType'], ['GET', '/rest/api/3/issueLink/133547'], ['POST', '/rest/api/3/issueLink'], ['DELETE', '/rest/api/3/issueLink/133547']]) {
    assert.equal(validateUrl(method!, path!, 'https://example.atlassian.net').pathname, path);
  }
  for (const [method, path] of [['POST', '/rest/api/3/issueLinkType'], ['PUT', '/rest/api/3/issueLink/133547'], ['DELETE', '/rest/api/3/issueLink'], ['GET', '/rest/api/3/issueLink/0'], ['GET', '/rest/api/3/issueLink/133547?expand=anything']]) {
    assert.throws(() => validateUrl(method!, path!, 'https://example.atlassian.net'), { code: 'security' });
  }
});

test('issue shows link ids, type and perspective in compact and JSON output', async () => {
  const r = await run(['issue', 'ED-1'], { before: [entry()] });
  assert.equal(r.exit, 0, r.output);
  assert.deepEqual(r.value.links, [{ id: '133547', type: 'blocks', key: 'ED-2', summary: 'Second issue', status: 'Done', linkType: { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, direction: 'outward' }]);
  assert.equal(r.calls[0]!.fields?.split(',').includes('issuelinks'), true);
  const compact = await run(['issue', 'ED-1'], { before: [entry(), entry('inward')] }, false);
  assert.match(compact.output, /links\[2\]\{id,type,relation,key,status,summary\}:\n  "133547",Blocks,blocks,ED-2,Done,Second issue\n  "133547",Blocks,is blocked by,ED-2,Done,Second issue/);
});
