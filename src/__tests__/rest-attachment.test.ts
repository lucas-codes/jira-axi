import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../index.ts';
import { upload } from '../api.ts';
import { parseArgs } from '../args.ts';
import { confirmWrite, type PlannedUpload } from '../write-plan.ts';
import { env } from './rest-harness.ts';

const plan = '---\nticket: DEMO-1\nstatus: draft\n---\n# Plan\n\n- [ ] step one\n\t- nested — “quoted”\n';
const binary = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
const attachments = [
  { id: '10001', filename: 'DEMO-1-scope-plan.md', size: 10, mimeType: 'text/markdown', created: '2026-01-01T10:00:00.000+0000', author: { displayName: 'Reader' } },
  { id: 10003, filename: 'DEMO-1-scope-plan.md', size: Buffer.byteLength(plan), mimeType: 'text/markdown', created: 1767348000000, author: { displayName: 'Reader' } },
  { id: '10002', filename: 'shot.png', size: 256, mimeType: 'image/png', created: '2026-01-02T08:00:00.000+0000' },
];

interface Scenario {
  issue?: unknown;
  meta?: unknown;
  metadata?: Record<string, unknown>;
  content?: Record<string, { status?: number; body?: Uint8Array; headers?: Record<string, string> }>;
  post?: { status: number; body?: unknown };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'jira-axi-attach-'));
}

// Routes by method and path so each test states what Jira holds, not which call comes next.
async function run(args: string[], scenario: Scenario = {}, json = true) {
  const calls: { method: string; url: URL; init?: RequestInit }[] = [];
  const chunks: (string | Uint8Array)[] = [];
  const exit = await main([...args, ...(json ? ['--json'] : [])], {
    env,
    stdin: { isTTY: true, read: () => '' },
    write: s => { chunks.push(s); },
    fetch: async (url, init) => {
      const u = new URL(String(url));
      const method = init?.method ?? 'GET';
      calls.push({ method, url: u, ...(init ? { init } : {}) });
      if (method === 'POST') {
        const { status, body } = scenario.post ?? { status: 200, body: [{ id: '10009', filename: 'uploaded', size: 0, mimeType: 'text/markdown', created: '2026-01-03T00:00:00.000+0000' }] };
        return Response.json(body ?? {}, { status });
      }
      if (u.pathname === '/rest/api/3/attachment/meta')
        return Response.json(scenario.meta ?? { enabled: true, uploadLimit: 10485760 });
      const content = /^\/rest\/api\/3\/attachment\/content\/(\d+)$/.exec(u.pathname);
      if (content) {
        const c = scenario.content?.[content[1]!] ?? { status: 404 };
        return new Response(c.body ?? null, { status: c.status ?? 200, headers: { 'content-type': 'application/octet-stream', ...c.headers } });
      }
      const meta = /^\/rest\/api\/3\/attachment\/(\d+)$/.exec(u.pathname);
      if (meta) {
        const m = scenario.metadata?.[meta[1]!];
        return m ? Response.json(m) : Response.json({ errorMessages: ['nope'] }, { status: 404 });
      }
      return Response.json(scenario.issue ?? { key: 'DEMO-1', fields: { summary: 'Fix it', attachment: attachments } });
    },
  });
  const output = chunks.map(c => typeof c === 'string' ? c : Buffer.from(c).toString('latin1')).join('');
  const bytes = chunks.filter((c): c is Uint8Array => typeof c !== 'string');
  let value: unknown;
  try { value = json ? JSON.parse(output) : undefined; } catch { value = undefined; }
  return { exit, output, chunks, bytes, calls, posts: calls.filter(c => c.method === 'POST'), value: value as Record<string, any> };
}

test('attachments lists newest first and normalizes id and created forms', async () => {
  const r = await run(['attachments', 'DEMO-1']);
  assert.equal(r.exit, 0, r.output);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0]!.url.searchParams.get('fields'), 'attachment');
  assert.deepEqual(r.value.attachments.map((a: { id: string }) => a.id), ['10003', '10002', '10001']);
  assert.equal(r.value.attachments[0].created, '2026-01-02T10:00:00.000Z');
  assert.equal(r.value.attachments[2].created, '2026-01-01T10:00:00.000Z');
  assert.equal(r.value.count, 3);
  const compact = await run(['attachments', 'DEMO-1'], {}, false);
  assert.match(compact.output, /^attachments\[3\]\{id,filename,size,mimeType,created,author\}:$/m);
  const empty = await run(['attachments', 'DEMO-1'], { issue: { key: 'DEMO-1', fields: {} } });
  assert.equal(empty.value.count, 0);
  for (const bad of [[{ id: 'x', filename: 'a', size: 1, created: '2026-01-01T00:00:00.000Z' }], [{ id: '1', filename: '', size: 1, created: '2026-01-01T00:00:00.000Z' }], [{ id: '1', filename: 'a', size: -1, created: '2026-01-01T00:00:00.000Z' }], [{ id: '1', filename: 'a', size: 1, created: 'yesterday' }], 'x'])
    assert.equal((await run(['attachments', 'DEMO-1'], { issue: { key: 'DEMO-1', fields: { attachment: bad } } })).value.code, 'bad_response', JSON.stringify(bad));
  assert.equal((await run(['attachments', 'DEMO-1', '--file', 'x'])).exit, 2);
});

test('attach previews with GETs only, then applies one multipart POST of the exact bytes', async () => {
  const dir = tmp();
  const file = join(dir, 'DEMO-1.md');
  writeFileSync(file, plan);
  const args = ['attach', 'DEMO-1', '--file', file, '--name', 'DEMO-1-scope-plan.md'];
  const preview = await run(args);
  assert.equal(preview.exit, 0, preview.output);
  assert.ok(preview.calls.every(c => c.method === 'GET'));
  assert.equal(preview.value.applied, false);
  assert.equal(preview.value.target, 'Fix it');
  assert.equal(preview.value.existing, 2);
  assert.match(preview.value.payloadDigest, /^[a-f0-9]{12}$/);
  const sha256 = createHash('sha256').update(plan).digest('hex');
  assert.deepEqual(preview.value.request, { method: 'POST', path: '/rest/api/3/issue/DEMO-1/attachments', query: {}, upload: { filename: 'DEMO-1-scope-plan.md', size: Buffer.byteLength(plan), sha256, mimeType: 'text/markdown' } });

  const applied = await run([...args, '--yes', '--confirm', preview.value.payloadDigest], { post: { status: 200, body: [{ id: 10010, filename: 'DEMO-1-scope-plan.md', size: Buffer.byteLength(plan), mimeType: 'text/markdown', created: '2026-01-03T00:00:00.000+0000' }] } });
  assert.equal(applied.exit, 0, applied.output);
  assert.equal(applied.posts.length, 1);
  const post = applied.posts[0]!;
  assert.equal(post.url.pathname, '/rest/api/3/issue/DEMO-1/attachments');
  const headers = post.init!.headers as Record<string, string>;
  assert.equal(headers['X-Atlassian-Token'], 'no-check');
  assert.equal(headers['Content-Type'], undefined);
  const form = post.init!.body as FormData;
  assert.deepEqual([...form.keys()], ['file']);
  const sent = form.get('file') as File;
  assert.equal(sent.name, 'DEMO-1-scope-plan.md');
  assert.equal(sent.type, 'text/markdown');
  assert.deepEqual(Buffer.from(await sent.arrayBuffer()), Buffer.from(plan));
  assert.equal(applied.value.applied, true);
  assert.equal(applied.value.attachmentId, '10010');
  assert.equal(applied.value.sha256, sha256);
  assert.equal(applied.value.payloadDigest, preview.value.payloadDigest);

  const basename = await run(['attach', 'DEMO-1', '--file', file]);
  assert.equal(basename.value.request.upload.filename, 'DEMO-1.md');
  const bin = join(dir, 'blob.bin');
  writeFileSync(bin, binary);
  assert.equal((await run(['attach', 'DEMO-1', '--file', bin])).value.request.upload.mimeType, 'application/octet-stream');
  const changed = join(dir, 'other.md');
  writeFileSync(changed, plan + 'x');
  assert.notEqual((await run(['attach', 'DEMO-1', '--file', changed, '--name', 'DEMO-1-scope-plan.md'])).value.payloadDigest, preview.value.payloadDigest);
  for (const flags of [['--confirm', preview.value.payloadDigest], ['--yes', '--confirm', '000000000000']]) {
    const r = await run([...args, ...flags]);
    assert.equal(r.exit, 2);
    assert.equal(r.posts.length, 0);
  }
});

test('upload refuses bytes that differ from the planned digest before sending', async () => {
  const bytes = Buffer.from(plan);
  const planned: PlannedUpload = { method: 'POST', path: '/rest/api/3/issue/DEMO-1/attachments', query: {}, upload: { filename: 'a.md', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mimeType: 'text/markdown' } };
  let calls = 0;
  const swapped = Buffer.from(plan.replace('draft', 'final'));
  await assert.rejects(upload(planned, confirmWrite(parseArgs(['attach', '--yes']), planned)!, swapped, { env, fetch: async () => { calls++; return Response.json([]); } }), { code: 'security', details: { applied: false } });
  assert.equal(calls, 0);
});

test('attach refuses bad names, sizes, settings and secrets before any POST', async () => {
  const dir = tmp();
  const file = join(dir, 'a.md');
  writeFileSync(file, plan);
  const control = await run(['attach', 'DEMO-1', '--file', file, '--name', 'bad\x1b[31m.md', '--yes']);
  assert.equal(control.value.code, 'security');
  assert.equal(control.value.applied, false);
  assert.equal(control.calls.length, 0);
  for (const name of ['a/b.md', 'a\\b.md', '.', '..', 'x'.repeat(256)]) {
    const r = await run(['attach', 'DEMO-1', '--file', file, '--name', name, '--yes']);
    assert.equal(r.exit, 2, name);
    assert.equal(r.calls.length, 0);
  }
  const empty = join(dir, 'empty.md');
  writeFileSync(empty, '');
  assert.equal((await run(['attach', 'DEMO-1', '--file', empty])).exit, 2);
  const big = join(dir, 'big.bin');
  writeFileSync(big, Buffer.alloc(10 * 1024 * 1024 + 1));
  const huge = await run(['attach', 'DEMO-1', '--file', big, '--yes']);
  assert.equal(huge.value.code, 'file_too_large');
  assert.equal(huge.calls.length, 0);
  const limited = await run(['attach', 'DEMO-1', '--file', file, '--yes'], { meta: { enabled: true, uploadLimit: 8 } });
  assert.equal(limited.value.code, 'file_too_large');
  assert.equal(limited.posts.length, 0);
  const disabled = await run(['attach', 'DEMO-1', '--file', file, '--yes'], { meta: { enabled: false, uploadLimit: 10 } });
  assert.equal(disabled.value.code, 'attachments_disabled');
  assert.equal(disabled.posts.length, 0);
  const leaky = join(dir, 'leak.md');
  writeFileSync(leaky, 'token: DUMMY_SECRET\n');
  const leak = await run(['attach', 'DEMO-1', '--file', leaky, '--yes']);
  assert.equal(leak.value.code, 'security');
  assert.equal(leak.calls.length, 0);
  assert.ok(!leak.output.includes('DUMMY_SECRET'));
  for (const args of [['attach', 'DEMO-1'], ['attach', 'DEMO-1', '--file', '-'], ['attach', '--file', file], ['attach', 'DEMO-1', 'extra', '--file', file], ['attach', 'DEMO-1', '--file', file, '--stdin']])
    assert.equal((await run(args)).exit, 2, args.join(' '));
});

test('attach classifies outcomes and never retries the POST', async () => {
  const dir = tmp();
  const file = join(dir, 'a.md');
  writeFileSync(file, plan);
  for (const [post, code, applied] of [
    [{ status: 413, body: {} }, 'payload_too_large', false],
    [{ status: 403, body: {} }, 'forbidden', false],
    [{ status: 500, body: {} }, 'write_outcome_unknown', 'unknown'],
    [{ status: 201, body: [{ id: '1', filename: 'a.md', size: 1, created: '2026-01-01T00:00:00.000Z' }] }, 'write_outcome_unknown', 'unknown'],
    [{ status: 200, body: { id: '1' } }, 'write_outcome_unknown', 'unknown'],
    [{ status: 200, body: [] }, 'write_outcome_unknown', 'unknown'],
  ] as const) {
    const r = await run(['attach', 'DEMO-1', '--file', file, '--yes'], { post });
    assert.equal(r.value.code, code, r.output);
    assert.equal(r.value.applied, applied, r.output);
    assert.equal(r.posts.length, 1);
    if (applied === 'unknown')
      assert.match(r.value.help[0], /jira-axi attachments DEMO-1/);
  }
  const mismatch = await run(['attach', 'DEMO-1', '--file', file, '--yes'], { post: { status: 200, body: [{ id: '7', filename: 'a.md', size: 3, created: '2026-01-01T00:00:00.000Z' }] } });
  assert.equal(mismatch.value.code, 'attachment_mismatch');
  assert.equal(mismatch.value.applied, true);
});

test('download by id writes the exact bytes atomically and refuses to clobber', async () => {
  const dir = tmp();
  for (const [id, body, filename] of [['10003', Buffer.from(plan), 'DEMO-1-scope-plan.md'], ['10002', binary, 'shot.png']] as const) {
    const out = join(dir, filename);
    const scenario = { metadata: { [id]: { ...attachments.find(a => String(a.id) === id), size: body.length } }, content: { [id]: { body } } };
    const r = await run(['download', id, '--out', out], scenario);
    assert.equal(r.exit, 0, r.output);
    assert.deepEqual(readFileSync(out), body);
    const content = r.calls.find(c => c.url.pathname.startsWith('/rest/api/3/attachment/content/'))!;
    assert.equal(content.url.searchParams.get('redirect'), 'false');
    assert.equal(r.value.sha256, createHash('sha256').update(body).digest('hex'));
    assert.equal(r.value.size, body.length);
    assert.equal(r.value.out, out);
    const again = await run(['download', id, '--out', out], scenario);
    assert.equal(again.value.code, 'file_exists');
    assert.equal(again.calls.length, 0);
    writeFileSync(out, 'local edits');
    assert.equal((await run(['download', id, '--out', out, '--force'], scenario)).exit, 0);
    assert.deepEqual(readFileSync(out), body);
  }
  const short = join(dir, 'short.md');
  const mismatch = await run(['download', '10003', '--out', short], { metadata: { 10003: attachments[1] }, content: { 10003: { body: Buffer.from(plan.slice(1)) } } });
  assert.equal(mismatch.value.code, 'size_mismatch');
  assert.equal(existsSync(short), false);
  const big = await run(['download', '10003', '--out', short], { metadata: { 10003: { ...attachments[1], size: 10 * 1024 * 1024 + 1 } } });
  assert.equal(big.value.code, 'response_too_large');
  assert.ok(big.calls.every(c => !c.url.pathname.includes('/content/')));
  const redirect = await run(['download', '10003', '--out', short], { metadata: { 10003: attachments[1] }, content: { 10003: { status: 303, headers: { location: 'https://media.example' } } } });
  assert.equal(redirect.value.code, 'security');
  assert.equal(existsSync(short), false);
  assert.deepEqual(readdirSync(dir).filter(f => f.endsWith('.tmp')), []);
  assert.equal((await run(['download', '10003', '--out', short], {})).value.code, 'not_found');
});

test('download by issue key and --name picks the newest exact filename match', async () => {
  const dir = tmp();
  const out = join(dir, 'plan.md');
  const r = await run(['download', 'DEMO-1', '--name', 'DEMO-1-scope-plan.md', '--out', out], { content: { 10003: { body: Buffer.from(plan) } } });
  assert.equal(r.exit, 0, r.output);
  assert.equal(r.value.id, '10003');
  assert.equal(r.value.issue, 'DEMO-1');
  assert.equal(readFileSync(out, 'utf8'), plan);
  assert.ok(r.calls.every(c => !/^\/rest\/api\/3\/attachment\/\d+$/.test(c.url.pathname)));
  const missing = await run(['download', 'DEMO-1', '--name', 'demo-1-scope-plan.md', '--out', join(dir, 'x')]);
  assert.equal(missing.value.code, 'not_found');
  assert.match(missing.value.help[0], /DEMO-1-scope-plan\.md/);
  for (const args of [['download', '10003', '--name', 'a', '--out', out], ['download', 'DEMO-1', '--out', out], ['download', '10003'], ['download', '0', '--out', out], ['download', '--out', out]])
    assert.equal((await run(args)).exit, 2, args.join(' '));
});

test('download --out - writes raw bytes to stdout only for safe text', async () => {
  const scenario = (body: Buffer) => ({ metadata: { 10003: { ...attachments[1], size: body.length } }, content: { 10003: { body } } });
  const ok = await run(['download', '10003', '--out', '-'], scenario(Buffer.from(plan)), false);
  assert.equal(ok.exit, 0, ok.output);
  assert.equal(ok.chunks.length, 1);
  assert.deepEqual(Buffer.from(ok.bytes[0]!), Buffer.from(plan));
  const crlf = Buffer.from('a\r\nb');
  assert.equal((await run(['download', '10003', '--out', '-'], scenario(crlf), false)).exit, 0);
  for (const body of [binary, Buffer.from('a\x1b[31mb'), Buffer.from('a\rb'), Buffer.from([0xc3]), Buffer.from('DUMMY_SECRET')]) {
    const r = await run(['download', '10003', '--out', '-'], scenario(body), false);
    assert.equal(r.exit, 1, JSON.stringify(body));
    assert.equal(r.bytes.length, 0);
    assert.match(r.output, /code: security/);
    assert.ok(!r.output.includes('DUMMY_SECRET'));
  }
  assert.equal((await run(['download', '10003', '--out', '-'], scenario(Buffer.from(plan)))).exit, 2);
});

test('compact attach preview and download summary, and acknowledged failures after upload', async () => {
  const dir = tmp();
  const file = join(dir, 'a.md');
  writeFileSync(file, plan);
  const preview = await run(['attach', 'DEMO-1', '--file', file], {}, false);
  assert.equal(preview.exit, 0, preview.output);
  assert.match(preview.output, /^existing: 0$/m);
  assert.match(preview.output, /^applied: false$/m);
  const out = join(dir, 'b.md');
  const summary = await run(['download', '10003', '--out', out], { metadata: { 10003: attachments[1] }, content: { 10003: { body: Buffer.from(plan) } } }, false);
  assert.equal(summary.exit, 0, summary.output);
  assert.match(summary.output, /^action: download-attachment$/m);
  const malformed = await run(['attach', 'DEMO-1', '--file', file, '--yes'], { post: { status: 200, body: [{ id: '7' }] } });
  assert.equal(malformed.value.code, 'bad_response');
  assert.equal(malformed.value.applied, true);
  let output = '';
  const exit = await main(['attach', 'DEMO-1', '--file', file, '--yes', '--json'], {
    env: { ...env, ATLASSIAN_API_TOKEN: 'attachmentId' }, stdin: { isTTY: true, read: () => '' }, write: s => { output += s; },
    fetch: async (url, init) => init?.method === 'POST' ? Response.json([{ id: '7', filename: 'a.md', size: Buffer.byteLength(plan), created: '2026-01-01T00:00:00.000Z' }]) : String(url).endsWith('/meta') ? Response.json({ enabled: true, uploadLimit: 100000 }) : Response.json({ key: 'DEMO-1', fields: {} }),
  });
  assert.equal(exit, 1);
  assert.equal(JSON.parse(output).applied, true);
  assert.ok(!output.includes('attachmentId'));
});

test('a failed rename leaves no temp file behind', async () => {
  const dir = tmp();
  const out = join(dir, 'taken');
  mkdirSync(join(out, 'child'), { recursive: true });
  const r = await run(['download', '10003', '--out', out, '--force'], { metadata: { 10003: attachments[1] }, content: { 10003: { body: Buffer.from(plan) } } });
  assert.equal(r.exit, 1);
  assert.deepEqual(readdirSync(dir), ['taken']);
});
