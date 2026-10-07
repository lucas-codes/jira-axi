import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const root = new URL('../../', import.meta.url).pathname;
const bun = spawnSync('bun', ['--version']).status === 0;

// prepack builds dist with bun, so the tarball check needs it; consumers of the tarball never do.
test('the npm tarball ships exactly the built CLI, its docs and the skill', { skip: !bun && 'bun is not installed' }, () => {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  // The prepack build prints to the same stdout ahead of npm's JSON.
  const [pack] = JSON.parse(r.stdout.slice(r.stdout.indexOf('\n[') + 1)) as { name: string; files: { path: string }[] }[];
  assert.equal(pack!.name, '@lucaslim/jira-axi');
  assert.deepEqual(pack!.files.map(f => f.path).sort(), ['LICENSE', 'README.md', 'bin/jira-axi', 'dist/index.js', 'package.json', 'skills/jira-axi/SKILL.md']);
});
