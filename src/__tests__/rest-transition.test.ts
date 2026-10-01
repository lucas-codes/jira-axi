import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../index.ts';
import { validateUrl } from '../api.ts';
import { env } from './rest-harness.ts';

const transitions = [
  { id: '2', name: 'Direct PR', to: { name: 'In Review' }, hasScreen: false },
  { id: '3', name: 'In Progress', to: { name: 'In Progress' }, hasScreen: false },
  { id: '111', name: 'Closed', to: { name: 'Closed' }, hasScreen: true },
  { id: '181', name: 'Under Consideration', to: { name: 'Under Consideration' }, hasScreen: false },
];

interface Scenario {
  transitions?: unknown;
  issues?: unknown[];
  post?: { status: number; body?: unknown };
}

// Routes by method and path rather than call order, so a test reads as "what Jira says" not "which call is next".
async function run(args: string[], scenario: Scenario = {}) {
  const calls: { method: string; url: URL; body?: unknown }[] = [];
  const issues = [...(scenario.issues ?? [{ key: 'DEMO-1', fields: { summary: 'Fix it', status: { name: 'Open' } } }])];
  let output = '';
  const exit = await main([...args, '--json'], {
    env,
    stdin: { isTTY: true, read: () => '' },
    write: s => { output += s; },
    fetch: async (url, init) => {
      const u = new URL(String(url));
      const method = init?.method ?? 'GET';
      calls.push({ method, url: u, ...(init?.body ? { body: JSON.parse(init.body as string) } : {}) });
      if (method === 'POST') {
        const { status, body } = scenario.post ?? { status: 204 };
        return status === 204 ? new Response(null, { status }) : Response.json(body ?? {}, { status });
      }
      if (u.pathname.endsWith('/transitions'))
        return Response.json({ transitions: 'transitions' in scenario ? scenario.transitions : transitions });
      return Response.json(issues.length > 1 ? issues.shift() : issues[0]);
    },
  });
  return { exit, output, calls, posts: calls.filter(c => c.method === 'POST'), value: JSON.parse(output) };
}

test('transitions lists id, name and target status from one GET', async () => {
  const r = await run(['transitions', 'DEMO-1']);
  assert.equal(r.exit, 0, r.output);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0]!.url.pathname, '/rest/api/3/issue/DEMO-1/transitions');
  assert.deepEqual(r.value, {
    issue: 'DEMO-1',
    count: 4,
    transitions: [
      { id: '2', name: 'Direct PR', to: 'In Review', hasScreen: false },
      { id: '3', name: 'In Progress', to: 'In Progress', hasScreen: false },
      { id: '111', name: 'Closed', to: 'Closed', hasScreen: true },
      { id: '181', name: 'Under Consideration', to: 'Under Consideration', hasScreen: false },
    ],
  });
});

test('transitions renders a compact table by default', async () => {
  let output = '';
  const exit = await main(['transitions', 'DEMO-1'], {
    env, stdin: { isTTY: true, read: () => '' }, write: s => { output += s; },
    fetch: async () => Response.json({ transitions }),
  });
  assert.equal(exit, 0, output);
  assert.match(output, /^issue: DEMO-1$/m);
  assert.match(output, /^transitions\[4\]\{id,name,to,screen\}:$/m);
  assert.match(output, /^ {2}"111",Closed,Closed,true$/m);
  assert.match(output, /^ {2}"2",Direct PR,In Review,false$/m);
});

test('transitions fails closed on malformed responses and unknown flags', async () => {
  for (const bad of [null, 'x', [{ id: '1' }], [{ id: 1, name: 'A', to: { name: 'B' } }], [{ id: '1', name: 'A', to: {} }], [{ id: '1', name: 'A', to: { name: 'B' }, hasScreen: 'yes' }]]) {
    const r = await run(['transitions', 'DEMO-1'], { transitions: bad });
    assert.equal(r.value.code, 'bad_response', JSON.stringify(bad));
  }
  assert.equal((await run(['transitions', 'DEMO-1', '--status', 'x'])).exit, 2);
  assert.equal((await run(['transitions'])).exit, 2);
});

test('transition previews the exact request and sends nothing without --yes', async () => {
  const r = await run(['transition', 'DEMO-1', '--to', 'in progress']);
  assert.equal(r.exit, 0, r.output);
  assert.equal(r.posts.length, 0);
  assert.equal(r.value.action, 'transition-issue');
  assert.equal(r.value.applied, false);
  assert.match(r.value.payloadDigest, /^[a-f0-9]{12}$/);
  assert.equal(r.value.issue, 'DEMO-1');
  assert.equal(r.value.target, 'Fix it');
  assert.equal(r.value.from, 'Open');
  assert.equal(r.value.transition, 'In Progress');
  assert.equal(r.value.to, 'In Progress');
  assert.deepEqual(r.value.request, { method: 'POST', path: '/rest/api/3/issue/DEMO-1/transitions', query: {}, body: { transition: { id: '3' } } });
});

test('transition text preview shows digest, request and applied: false', async () => {
  let output = '';
  const exit = await main(['transition', 'DEMO-1', '--to', 'Direct PR'], {
    env, stdin: { isTTY: true, read: () => '' }, write: s => { output += s; },
    fetch: async url => String(url).includes('/transitions') ? Response.json({ transitions }) : Response.json({ key: 'DEMO-1', fields: { summary: 'Fix it', status: { name: 'Open' } } }),
  });
  assert.equal(exit, 0, output);
  assert.match(output, /^action: transition-issue$/m);
  assert.match(output, /^payloadDigest: [a-f0-9]{12}$/m);
  assert.match(output, /^from: Open$/m);
  assert.match(output, /^to: In Review$/m);
  assert.match(output, /^applied: false$/m);
  assert.match(output, /Re-run the identical command with --yes/);
});

test('transition matches a transition name or a target status name, case-insensitively', async () => {
  const byName = await run(['transition', 'DEMO-1', '--to', 'direct pr']);
  assert.equal(byName.value.request.body.transition.id, '2');
  const byStatus = await run(['transition', 'DEMO-1', '--to', 'IN REVIEW']);
  assert.equal(byStatus.value.request.body.transition.id, '2');
  assert.equal(byStatus.value.to, 'In Review');
  const sameBoth = await run(['transition', 'DEMO-1', '--to', 'Under Consideration']);
  assert.equal(sameBoth.value.request.body.transition.id, '181');
});

test('transition applies with --yes and --confirm, then reads back the new status', async () => {
  const args = ['transition', 'DEMO-1', '--to', 'In Progress'];
  const preview = await run(args);
  const applied = await run([...args, '--yes', '--confirm', preview.value.payloadDigest], {
    issues: [
      { key: 'DEMO-1', fields: { summary: 'Fix it', status: { name: 'Open' } } },
      { key: 'DEMO-1', fields: { summary: 'Fix it', status: { name: 'In Progress' } } },
    ],
  });
  assert.equal(applied.exit, 0, applied.output);
  assert.equal(applied.posts.length, 1);
  assert.equal(applied.posts[0]!.url.pathname, '/rest/api/3/issue/DEMO-1/transitions');
  assert.deepEqual(applied.posts[0]!.body, preview.value.request.body);
  assert.equal(applied.calls.at(-1)!.method, 'GET');
  assert.equal(applied.calls.at(-1)!.url.pathname, '/rest/api/3/issue/DEMO-1');
  assert.equal(applied.value.applied, true);
  assert.equal(applied.value.payloadDigest, preview.value.payloadDigest);
  assert.equal(applied.value.from, 'Open');
  assert.equal(applied.value.status, 'In Progress');
  assert.equal(applied.value.url, 'https://example.atlassian.net/browse/DEMO-1');
});

test('transition reports the status Jira actually landed on, not the one requested', async () => {
  const r = await run(['transition', 'DEMO-1', '--to', 'Direct PR', '--yes'], {
    issues: [
      { key: 'DEMO-1', fields: { summary: 'Fix it', status: { name: 'Open' } } },
      { key: 'DEMO-1', fields: { summary: 'Fix it', status: { name: 'Merged' } } },
    ],
  });
  assert.equal(r.value.status, 'Merged');
  assert.equal(r.value.to, 'In Review');
});

test('--confirm without --yes, or with a wrong digest, refuses before any write', async () => {
  const args = ['transition', 'DEMO-1', '--to', 'In Progress'];
  const preview = await run(args);
  for (const flags of [['--confirm', preview.value.payloadDigest], ['--yes', '--confirm', 'bad'], ['--yes', '--confirm', '000000000000']]) {
    const r = await run([...args, ...flags]);
    assert.equal(r.exit, 2, r.output);
    assert.equal(r.posts.length, 0);
    assert.equal(r.value.applied, false);
  }
});

test('an unknown transition fails with the available options and applies nothing', async () => {
  const r = await run(['transition', 'DEMO-1', '--to', 'Reopen', '--yes']);
  assert.equal(r.exit, 1);
  assert.equal(r.value.code, 'not_found');
  assert.equal(r.value.applied, false);
  assert.equal(r.posts.length, 0);
  for (const option of ['Direct PR', 'In Review', 'In Progress', 'Closed', 'Under Consideration'])
    assert.ok(r.value.help[0].includes(option), `${option} missing from ${r.value.help[0]}`);
});

test('an ambiguous transition fails listing only the candidates and applies nothing', async () => {
  const ambiguous = [
    { id: '10', name: 'Review', to: { name: 'Done' }, hasScreen: false },
    { id: '11', name: 'Done', to: { name: 'Closed' }, hasScreen: false },
    { id: '12', name: 'Other', to: { name: 'Elsewhere' }, hasScreen: false },
  ];
  const r = await run(['transition', 'DEMO-1', '--to', 'done', '--yes'], { transitions: ambiguous });
  assert.equal(r.exit, 1);
  assert.equal(r.value.code, 'ambiguous_transition');
  assert.equal(r.value.applied, false);
  assert.equal(r.posts.length, 0);
  assert.ok(r.value.help[0].includes('Review') && r.value.help[0].includes('Closed'));
  assert.ok(!r.value.help[0].includes('Elsewhere'));
});

test('a screen transition with required fields is refused, naming them, in preview and apply', async () => {
  const screen = [{ id: '111', name: 'Closed', to: { name: 'Closed' }, hasScreen: true, fields: {
    resolution: { required: true, name: 'Resolution', hasDefaultValue: false },
    comment: { required: false, name: 'Comment' },
    assignee: { required: true, name: 'Assignee', hasDefaultValue: true },
  } }];
  for (const flags of [[], ['--yes']]) {
    const r = await run(['transition', 'DEMO-1', '--to', 'Closed', ...flags], { transitions: screen });
    assert.equal(r.exit, 1, r.output);
    assert.equal(r.value.code, 'transition_screen');
    assert.equal(r.value.applied, false);
    assert.equal(r.posts.length, 0);
    assert.match(r.value.error, /required fields/);
    assert.ok(r.value.help[0].includes('Resolution'));
    assert.ok(!r.value.help[0].includes('Comment') && !r.value.help[0].includes('Assignee'));
  }
});

test('a screen transition without required fields still proceeds', async () => {
  const screen = [{ id: '111', name: 'Closed', to: { name: 'Closed' }, hasScreen: true, fields: { comment: { required: false, name: 'Comment' } } }];
  const r = await run(['transition', 'DEMO-1', '--to', 'Closed'], { transitions: screen });
  assert.equal(r.exit, 0, r.output);
  assert.deepEqual(r.value.request.body, { transition: { id: '111' } });
});

test('the write asks Jira for transition fields; the read does not', async () => {
  const write = await run(['transition', 'DEMO-1', '--to', 'Closed']);
  assert.equal(write.calls.find(c => c.url.pathname.endsWith('/transitions'))!.url.searchParams.get('expand'), 'transitions.fields');
  const read = await run(['transitions', 'DEMO-1']);
  assert.equal(read.calls[0]!.url.searchParams.get('expand'), null);
});

test('terminal controls in --to refuse before any request, preview and apply', async () => {
  for (const yes of [false, true]) {
    const r = await run(['transition', 'DEMO-1', '--to', 'Bad' + String.fromCharCode(27), ...(yes ? ['--yes'] : [])]);
    assert.equal(r.exit, 1, r.output);
    assert.equal(r.value.code, 'security');
    assert.equal(r.value.applied, false);
    assert.equal(r.calls.length, 0);
    assert.match(r.value.error, /U\+001B/);
    assert.ok(!r.output.includes(String.fromCharCode(27)));
  }
});

test('usage errors: missing --to, extra positionals, unknown flags, bad keys, moved issue', async () => {
  for (const args of [['transition', 'DEMO-1'], ['transition', 'DEMO-1', 'In Progress'], ['transition', 'DEMO-1', '--to', 'x', '--status', 'y'], ['transition', 'nope', '--to', 'x'], ['transition', '--to', 'x']]) {
    const r = await run(args);
    assert.equal(r.exit, 2, args.join(' '));
    assert.equal(r.value.applied, false);
    assert.equal(r.calls.length, 0);
  }
  const moved = await run(['transition', 'DEMO-1', '--to', 'In Progress', '--yes'], { issues: [{ key: 'DEMO-2', fields: {} }] });
  assert.equal(moved.value.code, 'issue_moved');
  assert.equal(moved.posts.length, 0);
});

test('write outcomes never retry; uncertain ones say applied: unknown with a read-back', async () => {
  for (const [status, code, applied] of [[400, 'rejected', false], [401, 'unauthorized', false], [403, 'forbidden', false], [404, 'not_found', false], [429, 'rate_limited', false], [500, 'write_outcome_unknown', 'unknown'], [200, 'write_outcome_unknown', 'unknown'], [201, 'write_outcome_unknown', 'unknown']] as const) {
    const r = await run(['transition', 'DEMO-1', '--to', 'In Progress', '--yes'], { post: { status, body: { errorMessages: ['Nope'] } } });
    assert.equal(r.value.code, code, r.output);
    assert.equal(r.value.applied, applied);
    assert.equal(r.posts.length, 1);
    if (applied === 'unknown')
      assert.match(r.value.help[0], /jira-axi issue DEMO-1.*POSTs are not safe to retry/);
  }
});

test('a failed read-back after an applied transition still reports applied: true', async () => {
  let output = '';
  let issueReads = 0;
  const exit = await main(['transition', 'DEMO-1', '--to', 'In Progress', '--yes', '--json'], {
    env, stdin: { isTTY: true, read: () => '' }, write: s => { output += s; },
    fetch: async (url, init) => {
      if (init?.method === 'POST') return new Response(null, { status: 204 });
      if (String(url).includes('/transitions')) return Response.json({ transitions });
      return ++issueReads === 1 ? Response.json({ key: 'DEMO-1', fields: { summary: 'Fix it', status: { name: 'Open' } } }) : new Response(null, { status: 500 });
    },
  });
  const value = JSON.parse(output);
  assert.equal(exit, 1);
  assert.equal(value.applied, true);
  assert.match(value.error, /applied/i);
  assert.match(value.help[0], /jira-axi issue DEMO-1/);
});

test('the transitions routes are allowlisted for the right methods only', () => {
  const origin = 'https://example.atlassian.net';
  assert.doesNotThrow(() => validateUrl('GET', '/rest/api/3/issue/DEMO-1/transitions', origin));
  assert.doesNotThrow(() => validateUrl('GET', '/rest/api/3/issue/DEMO-1/transitions?expand=transitions.fields', origin));
  assert.doesNotThrow(() => validateUrl('POST', '/rest/api/3/issue/DEMO-1/transitions', origin));
  assert.throws(() => validateUrl('PUT', '/rest/api/3/issue/DEMO-1/transitions', origin), /Disallowed/);
  assert.throws(() => validateUrl('GET', '/rest/api/3/issue/DEMO-1/transitions?skipRemoteOnlyCondition=true', origin), /Disallowed/);
  assert.throws(() => validateUrl('POST', '/rest/api/3/issue/DEMO-1/transitions?x=1', origin), /Disallowed/);
});

test('help documents both commands and the --to flag', async () => {
  let output = '';
  await main(['--help'], { env, stdin: { isTTY: true, read: () => '' }, write: s => { output += s; }, fetch: async () => { throw new Error('help must not call Jira'); } });
  assert.match(output, /transitions, comment, create, edit, transition, me/);
  assert.match(output, /--to <name>/);
  assert.match(output, /jira-axi transitions DEMO-101/);
  assert.match(output, /jira-axi transition DEMO-101 --to "In Progress" --yes/);
});
