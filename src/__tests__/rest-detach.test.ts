import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../index.ts';
import { env } from './rest-harness.ts';

const attachment = { id: '644426', filename: 'ED-1-scope-plan.md', size: 120, mimeType: 'text/markdown', created: '2026-10-07T04:02:58.742+0000', author: { displayName: 'Reader' } };

interface Scenario {
  metadata?: { status: number; body?: unknown };
  delete?: { status: number; body?: unknown };
}

// Routes by method so each test states what Jira answers, not which call comes next.
async function run(args: string[], scenario: Scenario = {}, json = true) {
  const calls: { method: string; url: URL; init?: RequestInit }[] = [];
  let output = '';
  const exit = await main([...args, ...(json ? ['--json'] : [])], {
    env,
    stdin: { isTTY: true, read: () => '' },
    write: s => { output += s; },
    fetch: async (url, init) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, url: new URL(String(url)), ...(init ? { init } : {}) });
      if (method === 'DELETE') {
        const { status, body } = scenario.delete ?? { status: 204 };
        return body === undefined ? new Response(null, { status }) : Response.json(body, { status });
      }
      const { status, body } = scenario.metadata ?? { status: 200, body: attachment };
      return Response.json(body ?? { errorMessages: ['nope'] }, { status });
    },
  });
  return { exit, output, calls, deletes: calls.filter(c => c.method === 'DELETE'), value: json ? JSON.parse(output) : undefined };
}

test('detach previews the attachment with one GET, then applies one DELETE', async () => {
  const preview = await run(['detach', '644426']);
  assert.equal(preview.exit, 0, preview.output);
  assert.deepEqual(preview.calls.map(c => `${c.method} ${c.url.pathname}`), ['GET /rest/api/3/attachment/644426']);
  assert.equal(preview.value.action, 'delete-attachment');
  assert.equal(preview.value.applied, false);
  assert.equal(preview.value.id, '644426');
  assert.equal(preview.value.filename, 'ED-1-scope-plan.md');
  assert.equal(preview.value.size, 120);
  assert.equal(preview.value.author, 'Reader');
  assert.equal(preview.value.created, '2026-10-07T04:02:58.742Z');
  assert.match(preview.value.payloadDigest, /^[a-f0-9]{12}$/);
  assert.deepEqual(preview.value.request, { method: 'DELETE', path: '/rest/api/3/attachment/644426', query: {} });

  const applied = await run(['detach', '644426', '--yes', '--confirm', preview.value.payloadDigest]);
  assert.equal(applied.exit, 0, applied.output);
  assert.equal(applied.deletes.length, 1);
  assert.equal(applied.deletes[0]!.url.pathname, '/rest/api/3/attachment/644426');
  assert.equal(applied.deletes[0]!.init!.body, undefined);
  assert.deepEqual({ action: applied.value.action, applied: applied.value.applied, id: applied.value.id, filename: applied.value.filename, payloadDigest: applied.value.payloadDigest }, { action: 'delete-attachment', applied: true, id: '644426', filename: 'ED-1-scope-plan.md', payloadDigest: preview.value.payloadDigest });

  const compact = await run(['detach', '644426'], {}, false);
  assert.match(compact.output, /^filename: ED-1-scope-plan\.md$/m);
  assert.match(compact.output, /^applied: false$/m);
  assert.notEqual((await run(['detach', '644427'])).value.payloadDigest, preview.value.payloadDigest);
});

test('detach names the missing permission on 403 and applies nothing', async () => {
  const r = await run(['detach', '644426', '--yes'], { delete: { status: 403, body: {} } });
  assert.equal(r.exit, 1);
  assert.equal(r.value.code, 'forbidden');
  assert.equal(r.value.applied, false);
  assert.match(r.value.help[0], /Delete own attachments/);
  assert.match(r.value.help[0], /Delete all attachments/);
  assert.equal(r.deletes.length, 1);
  const unreadable = await run(['detach', '644426', '--yes'], { metadata: { status: 403 } });
  assert.equal(unreadable.value.code, 'forbidden');
  assert.equal(unreadable.value.applied, false);
  assert.equal(unreadable.deletes.length, 0);
});

test('a missing attachment reads as already gone and never sends a DELETE', async () => {
  const gone = await run(['detach', '644426', '--yes'], { metadata: { status: 404 } });
  assert.equal(gone.exit, 1);
  assert.equal(gone.value.code, 'not_found');
  assert.equal(gone.value.applied, false);
  assert.match(gone.value.error, /644426/);
  assert.match(gone.value.help[0], /applied: unknown/);
  assert.equal(gone.deletes.length, 0);
  const raced = await run(['detach', '644426', '--yes'], { delete: { status: 404, body: {} } });
  assert.equal(raced.value.code, 'not_found');
  assert.equal(raced.value.applied, false);
  assert.match(raced.value.error, /already deleted/);
  assert.equal(raced.deletes.length, 1);
});

test('an uncertain delete is never retried and points at a read-only read-back', async () => {
  for (const del of [{ status: 500, body: {} }, { status: 200, body: {} }]) {
    const r = await run(['detach', '644426', '--yes'], { delete: del });
    assert.equal(r.value.code, 'write_outcome_unknown', r.output);
    assert.equal(r.value.applied, 'unknown');
    assert.equal(r.deletes.length, 1);
    assert.match(r.value.help[0], /jira-axi detach 644426/);
  }
});

test('detach usage errors send nothing', async () => {
  for (const args of [['detach'], ['detach', 'ED-1'], ['detach', '0'], ['detach', '1', '2'], ['detach', '1', '--name', 'a'], ['detach', '1', '--confirm', '000000000000'], ['detach', '1', '--yes', '--confirm', '000000000000']]) {
    const r = await run(args);
    assert.equal(r.exit, 2, args.join(' '));
    assert.equal(r.deletes.length, 0, args.join(' '));
  }
});

test('a delete followed by refused output still reports applied: true', async () => {
  let output = '';
  const exit = await main(['detach', '644426', '--yes', '--json'], {
    env: { ...env, ATLASSIAN_API_TOKEN: 'mimeType' }, stdin: { isTTY: true, read: () => '' }, write: s => { output += s; },
    fetch: async (_url, init) => init?.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json(attachment),
  });
  assert.equal(exit, 1);
  assert.equal(JSON.parse(output).applied, true);
  assert.ok(!output.includes('mimeType'));
});
