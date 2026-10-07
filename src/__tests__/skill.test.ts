import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { helpText } from '../help.ts';

// The skill defers to --help for flags, so its one way to drift is a command it never names.
test('the skill names every command listed by --help', () => {
  const line = helpText().match(/^commands\[\d+\]:\n {2}(.+)$/m)?.[1];
  assert.ok(line);
  const skill = readFileSync(new URL('../../skills/jira-axi/SKILL.md', import.meta.url), 'utf8');
  for (const command of line.replace('(none)=', '').split(', '))
    assert.ok(skill.includes('`' + command + '`'), `SKILL.md never mentions \`${command}\``);
});
