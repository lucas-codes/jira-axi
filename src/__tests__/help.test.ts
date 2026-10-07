import assert from 'node:assert/strict';
import test from 'node:test';
import { helpText } from '../help.ts';
import { COMMENT_FLAGS, CREATE_FLAGS, EDIT_FLAGS } from '../commands/rest-write.ts';
import { ISSUE_FLAGS, LIST_FLAGS, SPRINT_FLAGS } from '../commands/rest-read.ts';
import { TRANSITION_FLAGS, TRANSITIONS_FLAGS } from '../commands/rest-transition.ts';
import { ATTACH_FLAGS, ATTACHMENTS_FLAGS, DETACH_FLAGS, DOWNLOAD_FLAGS } from '../commands/rest-attachment.ts';

test('help lists every flag spelling accepted by a command and reports the exact count', () => {
  const help = helpText();
  const flagsHeader = help.match(/^flags\[(\d+)\]:$/m);
  assert.ok(flagsHeader);
  const listed = help.split(flagsHeader[0])[1]?.split('\n')[1]?.trim();
  assert.ok(listed);
  const spellings = new Set(listed.split(', ').flatMap(item => item.split('/').map(spelling => spelling.split(' ')[0])));
  for (const flag of new Set([
    ...ISSUE_FLAGS, ...LIST_FLAGS, ...SPRINT_FLAGS, ...COMMENT_FLAGS,
    ...CREATE_FLAGS, ...EDIT_FLAGS, ...TRANSITIONS_FLAGS, ...TRANSITION_FLAGS,
    ...ATTACHMENTS_FLAGS, ...ATTACH_FLAGS, ...DOWNLOAD_FLAGS, ...DETACH_FLAGS,
  ])) {
    const spelling = flag.length === 1 ? `-${flag}` : `--${flag}`;
    assert.ok(spellings.has(spelling), `help is missing ${spelling}`);
  }
  assert.match(help, new RegExp(`^flags\\[${listed.split(', ').length}\\]:$`, 'm'));
});
