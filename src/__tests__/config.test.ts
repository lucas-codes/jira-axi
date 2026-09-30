import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../index.ts';
import { siteOrigin } from '../site.ts';
import { env as baseEnv } from './rest-harness.ts';

async function exec(argv: string[], env: Record<string, string | undefined>, responses: unknown[] = []) {
  const calls: string[] = [];
  let output = '';
  const exit = await main(argv, {
    env,
    fetch: async (url) => {
      calls.push(String(url));
      return Response.json(responses.shift() ?? {});
    },
    write: (s) => { output += s; },
    stdin: { isTTY: true, read: () => '' },
  });
  return { exit, output, calls, json: argv.includes('--json') ? JSON.parse(output) : undefined };
}
const me = { accountId: 'abc', emailAddress: 'reader@example.com' };

test('siteOrigin accepts a bare host or https URL and normalizes to the origin', () => {
  for (const site of ['acme.atlassian.net', 'https://acme.atlassian.net', 'https://acme.atlassian.net/', 'ACME.Atlassian.NET'])
    assert.equal(siteOrigin({ ATLASSIAN_SITE: site }), 'https://acme.atlassian.net', site);
});

test('siteOrigin rejects foreign hosts, http, paths, ports, userinfo, query and fragment', () => {
  for (const site of [
    'evil.test', 'acme.atlassian.net.evil.test', 'evil.test/acme.atlassian.net', 'a.b.atlassian.net',
    'http://acme.atlassian.net', 'https://acme.atlassian.net/wiki', 'https://acme.atlassian.net//',
    'https://acme.atlassian.net:444', 'https://user@acme.atlassian.net', 'acme.atlassian.net?x=1',
    'acme.atlassian.net#frag', ' acme.atlassian.net', 'acme.atlassian.net\n', '.atlassian.net', '-a.atlassian.net',
  ])
    assert.throws(() => siteOrigin({ ATLASSIAN_SITE: site }), { code: 'usage' }, JSON.stringify(site));
});

test('a missing site fails like missing credentials and names all three variables', async () => {
  for (const site of [undefined, '']) {
    const r = await exec(['me', '--json'], { ...baseEnv, ATLASSIAN_SITE: site });
    assert.equal(r.exit, 1);
    assert.equal(r.json.code, 'token_missing');
    for (const name of ['ATLASSIAN_EMAIL', 'ATLASSIAN_API_TOKEN', 'ATLASSIAN_SITE'])
      assert.ok(r.json.error.includes(name), r.output);
    assert.match(r.json.help[0], /README/);
    assert.equal(r.calls.length, 0);
  }
});

test('an invalid site is a usage error and nothing is fetched', async () => {
  for (const site of ['evil.test', 'http://example.atlassian.net', 'https://example.atlassian.net/wiki']) {
    const r = await exec(['me', '--json'], { ...baseEnv, ATLASSIAN_SITE: site });
    assert.equal(r.exit, 2, site);
    assert.equal(r.json.code, 'usage');
    assert.equal(r.calls.length, 0);
  }
});

test('bare host and https URL both resolve requests to the same origin', async () => {
  for (const site of ['example.atlassian.net', 'https://example.atlassian.net']) {
    const r = await exec(['me', '--json'], { ...baseEnv, ATLASSIAN_SITE: site }, [me]);
    assert.equal(r.exit, 0, r.output);
    assert.equal(r.json.server, 'https://example.atlassian.net');
    assert.equal(new URL(r.calls[0]!).origin, 'https://example.atlassian.net');
  }
});

test('--help and --version need no environment', async () => {
  for (const argv of [['--help'], ['--version']]) {
    const r = await exec(argv, {});
    assert.equal(r.exit, 0);
    assert.equal(r.calls.length, 0);
  }
});

test('status reports the resolved server and stays exit zero when the site is missing', async () => {
  const ok = await exec(['status'], baseEnv, [me, { id: 42, name: 'Board' }]);
  assert.match(ok.output, /^server: "https:\/\/example\.atlassian\.net"$/m);
  const missing = await exec(['status', '--json'], { ...baseEnv, ATLASSIAN_SITE: undefined });
  assert.equal(missing.exit, 0);
  assert.equal(missing.json.reachable, false);
  assert.ok(!('server' in missing.json));
  assert.equal(missing.calls.length, 0);
});

test('JIRA_PROJECT is the default project and --project overrides it', async () => {
  const fallback = await exec(['list', '--json'], baseEnv, [{ issues: [], isLast: true }]);
  assert.match(new URL(fallback.calls[0]!).searchParams.get('jql')!, /^project="DEMO" /);
  const lower = await exec(['list', '--json'], { ...baseEnv, JIRA_PROJECT: 'demo' }, [{ issues: [], isLast: true }]);
  assert.match(new URL(lower.calls[0]!).searchParams.get('jql')!, /^project="DEMO" /);
  for (const flag of ['--project', '-p']) {
    const r = await exec(['list', flag, 'other', '--json'], baseEnv, [{ issues: [], isLast: true }]);
    assert.match(new URL(r.calls[0]!).searchParams.get('jql')!, /^project="OTHER" /);
  }
});

test('a command that needs a project fails naming --project and JIRA_PROJECT when neither is set', async () => {
  const env = { ...baseEnv, JIRA_PROJECT: undefined };
  for (const argv of [['list'], ['issue', '123'], ['create', '--summary', 'New', '--type', 'Task'], ['edit', '123', '--priority', 'High']]) {
    const r = await exec([...argv, '--json'], env);
    assert.equal(r.exit, 2, argv.join(' '));
    assert.equal(r.json.code, 'usage');
    assert.match(r.json.error, /--project/);
    assert.match(r.json.error, /JIRA_PROJECT/);
    assert.equal(r.calls.length, 0);
  }
});

test('commands with a full issue key or their own project clause need no configured project', async () => {
  const env = { ...baseEnv, JIRA_PROJECT: undefined };
  const issue = await exec(['DEMO-1', '--json'], env, [{ key: 'DEMO-1', fields: {} }, { comments: [], total: 0 }]);
  assert.equal(issue.exit, 0, issue.output);
  const list = await exec(['list', '--jql', 'project = DEMO', '--json'], env, [{ issues: [], isLast: true }]);
  assert.equal(list.exit, 0, list.output);
  const status = await exec(['status'], env, [me, { id: 42, name: 'Board' }]);
  assert.equal(status.exit, 0);
  assert.ok(!/^project:/m.test(status.output));
});

test('an invalid JIRA_PROJECT or --project is a usage error', async () => {
  for (const [env, argv] of [
    [{ ...baseEnv, JIRA_PROJECT: 'not valid' }, ['list']],
    [{ ...baseEnv, JIRA_PROJECT: '1X' }, ['list']],
    [baseEnv, ['list', '--project', 'bad key']],
  ] as const) {
    const r = await exec([...argv, '--json'], env);
    assert.equal(r.exit, 2);
    assert.equal(r.json.code, 'usage');
    assert.equal(r.calls.length, 0);
  }
});

test('sprint commands need JIRA_BOARD and name it when unset or invalid', async () => {
  for (const board of [undefined, '', '0', '-3', '1.5', 'abc', '9007199254740993']) {
    for (const argv of [['sprint'], ['list', '--sprint', 'current']]) {
      const r = await exec([...argv, '--json'], { ...baseEnv, JIRA_BOARD: board });
      assert.equal(r.exit, 2, `${board} ${argv.join(' ')}`);
      assert.equal(r.json.code, 'usage');
      assert.match(r.json.error, /JIRA_BOARD/);
      assert.equal(r.calls.length, 0);
    }
  }
});

test('the configured board id is used for board requests', async () => {
  const r = await exec(['sprint', '--json'], { ...baseEnv, JIRA_BOARD: '7' }, [{ values: [{ id: 1, name: 'Sprint 1', state: 'active' }], isLast: true }]);
  assert.equal(r.exit, 0, r.output);
  assert.equal(new URL(r.calls[0]!).pathname, '/rest/agile/1.0/board/7/sprint');
  const status = await exec(['status', '--json'], { ...baseEnv, JIRA_BOARD: '7' }, [me, { id: 7, name: 'Seven' }]);
  assert.equal(status.json.board, 'Seven');
  assert.equal(new URL(status.calls[1]!).pathname, '/rest/agile/1.0/board/7');
});

test('status omits the board line and makes no board request when JIRA_BOARD is unset', async () => {
  const r = await exec(['status'], { ...baseEnv, JIRA_BOARD: undefined }, [me]);
  assert.equal(r.exit, 0);
  assert.equal(r.calls.length, 1);
  assert.ok(!/^board:/m.test(r.output));
});

test('sprint refuses a project other than the configured one', async () => {
  const other = await exec(['sprint', '--project', 'other', '--json'], baseEnv);
  assert.equal(other.exit, 2);
  assert.equal(other.json.code, 'usage');
  assert.match(other.json.error, /DEMO/);
  assert.equal(other.calls.length, 0);
  const unset = await exec(['sprint', '--project', 'demo', '--json'], { ...baseEnv, JIRA_PROJECT: undefined });
  assert.equal(unset.exit, 2);
  assert.match(unset.json.error, /JIRA_PROJECT/);
  const same = await exec(['sprint', '--project', 'demo', '--json'], baseEnv, [{ values: [], isLast: true }]);
  assert.equal(same.exit, 0, same.output);
});
